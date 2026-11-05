import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { collectTurnUsage, turnUsageSchema, requestMetadataSchema } from './turn-usage';
import { costSchema, estimateTurnCost } from './cost';
import { PING } from './core';

type Event = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
const eventTypes = ['thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'client/turn/requested', 'client/turn/rejected', 'provider/modelFallback', 'thread/extensionState/updated'] as const;
export const savedTurnSchema = z.object({
  providerId: z.string().default('codex'),
  turnId: z.string(), startSeq: z.number(), startedAt: z.number(), updatedAt: z.number(),
  completed: z.boolean(), keepalive: z.boolean(), turn: turnUsageSchema, cost: costSchema,
});
export type SavedTurn = z.infer<typeof savedTurnSchema>;
const totalSchema = z.object({ known: z.number(), unknownTurns: z.number().int() });
export const sessionStatisticsSchema = z.object({
  providerId: z.string().default('codex'),
  turns: z.array(savedTurnSchema), totalTurns: z.number(), keepaliveTurns: z.number(),
  input: totalSchema, output: totalSchema, read: totalSchema, written: totalSchema,
  // Over turns that report cache-write lifetimes (Claude Code Telemetry).
  writeLifetimeTurns: z.number().int().nonnegative().default(0),
  written5m: totalSchema.default({ known: 0, unknownTurns: 0 }), written1h: totalSchema.default({ known: 0, unknownTurns: 0 }),
  writtenUnknownLifetime: totalSchema.default({ known: 0, unknownTurns: 0 }),
  costMin: totalSchema, costMax: totalSchema, keepaliveCostMin: totalSchema, keepaliveCostMax: totalSchema,
  unattributedReports: z.number().int().nonnegative(),
  nextBeforeSeq: z.number().nullable(), syncedThroughSeq: z.number(),
});
export type SessionStatistics = z.infer<typeof sessionStatisticsSchema>;

// Bump when saved snapshots must be recomputed. 3: re-read retained events for
// cache-write lifetimes. 4: estimate usage without a model at the turn's model.
const REVISION = 4;

export function createStatistics(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE cache_events (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id, seq))`,
    `CREATE TABLE cache_cursors (thread_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)`,
    `CREATE TABLE cache_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, start_seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id, turn_id))`,
    `CREATE INDEX cache_turn_order ON cache_turns(thread_id, start_seq)`,
    `CREATE TABLE cache_statistics_versions (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
  ]);
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  const pending = new Map<string, Promise<void>>();
  const getCursor = (threadId: string) => (db.prepare('SELECT seq FROM cache_cursors WHERE thread_id = ?').get(threadId) as { seq: number } | undefined)?.seq ?? 0;
  const load = (threadId: string): Event[] => (db.prepare('SELECT body FROM cache_events WHERE thread_id = ? ORDER BY seq').all(threadId) as { body: string }[]).map(row => JSON.parse(row.body));
  function rebuild(threadId: string, providerId: string, changedAfter: number) {
    const rows = load(threadId);
    const starts = rows.filter(row => row.type === 'turn/started' && row.scope.kind === 'turn');
    const seen = new Set<string>();
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      if (start.scope.kind !== 'turn' || seen.has(start.scope.turnId)) continue;
      const turnId = start.scope.turnId;
      seen.add(turnId);
      const next = starts.slice(index + 1).find(row => row.scope.kind === 'turn' && row.scope.turnId !== turnId);
      const end = next?.seq ?? Infinity;
      if (end <= changedAfter) continue;
      const prefix = rows.filter(row => row.seq < end);
      // A next-turn request precedes its turn/started event; cost attribution
      // chooses the execution request before this turn's own boundary.
      const request = [...prefix].reverse().find(row => row.seq < start.seq && row.type === 'client/turn/requested');
      const usage = collectTurnUsage(prefix, providerId);
      const scoped = prefix.filter(row => row.seq >= start.seq && row.scope.kind === 'turn' && row.scope.turnId === turnId);
      const completed = scoped.some(row => row.type === 'turn/completed');
      const cost = estimateTurnCost(providerId, prefix);
      if (completed && usage.steps.length === 0) {
        usage.note = 'No usage reports available for this completed turn.';
        cost.note = 'Cost unavailable: this completed turn has no retained usage reports.';
      }
      const saved: SavedTurn = {
        providerId, turnId, startSeq: start.seq, startedAt: start.createdAt,
        updatedAt: scoped[scoped.length - 1]?.createdAt ?? start.createdAt,
        completed,
        keepalive: request?.type === 'client/turn/requested' && request.data.input.some(part => part.type === 'text' && part.text === PING),
        turn: usage, cost,
      };
      db.prepare('INSERT INTO cache_turns VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET start_seq=excluded.start_seq, body=excluded.body')
        .run(threadId, turnId, start.seq, JSON.stringify(saved));
    }
  }
  async function ingest(threadId: string, providerId?: string) {
    if (disposed) return;
    const thread = providerId === undefined ? await bb.sdk.threads.get({ threadId }) : null;
    if (disposed || (thread && thread.deletedAt !== null)) return;
    const provider = providerId ?? thread!.providerId;
    const revision = db.prepare('SELECT revision FROM cache_statistics_versions WHERE thread_id = ?').get(threadId) as { revision: number } | undefined;
    const needsRebuild = revision?.revision !== REVISION;
    const initial = getCursor(threadId);
    let cursor = needsRebuild ? 0 : initial;
    while (!disposed) {
      const batch = await bb.sdk.threads.events.list({ threadId, order: 'asc', limit: '100', afterSeq: String(cursor), types: eventTypes });
      if (disposed) return;
      const fresh = batch.filter(row => Number.isSafeInteger(row.seq) && row.seq > cursor).sort((a, b) => a.seq - b.seq);
      if (!fresh.length) break;
      db.transaction(() => {
        for (const row of fresh) {
          if (row.type === 'thread/extensionState/updated' && row.data.kind !== 'claude-code-telemetry/usage') continue;
          // Persist telemetry and model selection, never conversation text or prompts.
          const metadata = row.type === 'thread/extensionState/updated' ? requestMetadataSchema.safeParse(row.data.payload) : null;
          const safe = row.type === 'thread/extensionState/updated' ? { ...row, data: { kind: row.data.kind, payload: metadata?.success ? metadata.data : null } } : row.type === 'client/turn/requested' ? { ...row, data: { ...row.data, input: row.data.input.some(part => part.type === 'text' && part.text === PING)
            ? [{ type: 'text', text: PING, mentions: [] }] : [] } } : row;
          db.prepare('INSERT OR REPLACE INTO cache_events VALUES (?, ?, ?)').run(threadId, row.seq, JSON.stringify(safe));
        }
        cursor = fresh[fresh.length - 1].seq;
        // Snapshot update and cursor commit are atomic, including across reloads.
        rebuild(threadId, provider, initial);
        db.prepare('INSERT INTO cache_cursors VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq').run(threadId, cursor);
      })();
      if (batch.length < 100) break;
    }
    if (disposed) return;
    if (needsRebuild) db.transaction(() => {
      db.prepare("DELETE FROM cache_events WHERE thread_id = ? AND json_extract(body, '$.type') = 'thread/extensionState/updated' AND json_extract(body, '$.data.kind') != 'claude-code-telemetry/usage'").run(threadId);
      rebuild(threadId, provider, 0);
      db.prepare('INSERT INTO cache_statistics_versions VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision').run(threadId, REVISION);
    })();
    if (cursor > initial || needsRebuild) bb.realtime.publish('statistics-changed', { threadId });
  }
  function sync(threadId: string, providerId?: string): Promise<void> {
    const task = (pending.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => ingest(threadId, providerId));
    pending.set(threadId, task);
    void task.finally(() => { if (pending.get(threadId) === task) pending.delete(threadId); }).catch(() => {});
    return task;
  }
  function parseSaved(body: string): SavedTurn {
    const saved = savedTurnSchema.parse(JSON.parse(body));
    if (saved.completed && saved.turn.steps.length === 0) {
      saved.turn.note = 'No usage reports available for this completed turn.';
      saved.cost.note = 'Cost unavailable: this completed turn has no retained usage reports.';
    }
    return saved;
  }
  const readTurns = (threadId: string): SavedTurn[] => (db.prepare('SELECT body FROM cache_turns WHERE thread_id = ? ORDER BY start_seq DESC').all(threadId) as { body: string }[])
    .map(row => parseSaved(row.body));
  function session(threadId: string, beforeSeq?: number): SessionStatistics {
    const all = readTurns(threadId);
    const available = beforeSeq === undefined ? all : all.filter(turn => turn.startSeq < beforeSeq);
    const turns = available.slice(0, 50);
    const total = (pick: (turn: SavedTurn) => number | null, selected = all) => selected.reduce((sum, turn) => {
      const n = pick(turn); if (n === null) sum.unknownTurns++; else sum.known += n;
      return sum;
    }, { known: 0, unknownTurns: 0 });
    const turnIds = new Set(all.map(turn => turn.turnId));
    const unattributedReports = load(threadId).filter(row => row.type === 'thread/tokenUsage/updated' && (row.scope.kind !== 'turn' || !turnIds.has(row.scope.turnId))).length;
    const keepalives = all.filter(turn => turn.keepalive);
    const lifetimeTurns = all.filter(turn => turn.turn.writeLifetimes);
    return { providerId: all[0]?.providerId ?? 'unknown', unattributedReports, turns, totalTurns: all.length, keepaliveTurns: all.filter(turn => turn.keepalive).length,
      input: total(s => s.turn.inputTokens), output: total(s => s.turn.outputTokens),
      read: total(s => s.turn.readTokens), written: total(s => s.turn.writeTokens),
      writeLifetimeTurns: lifetimeTurns.length,
      written5m: total(s => s.turn.writeLifetimes!.fiveMinuteTokens, lifetimeTurns),
      written1h: total(s => s.turn.writeLifetimes!.oneHourTokens, lifetimeTurns),
      writtenUnknownLifetime: total(s => s.turn.writeLifetimes!.unknownTokens, lifetimeTurns),
      costMin: total(s => s.cost.minUsd), costMax: total(s => s.cost.maxUsd),
      keepaliveCostMin: total(s => s.cost.minUsd, keepalives), keepaliveCostMax: total(s => s.cost.maxUsd, keepalives),
      nextBeforeSeq: available.length > turns.length ? turns[turns.length - 1].startSeq : null,
      syncedThroughSeq: getCursor(threadId) };
  }
  function turn(threadId: string, turnId: string): SavedTurn | null {
    const row = db.prepare('SELECT body FROM cache_turns WHERE thread_id = ? AND turn_id = ?').get(threadId, turnId) as { body: string } | undefined;
    return row ? parseSaved(row.body) : null;
  }
  bb.events.on('experimental_thread.events', ({ thread }) => thread.deletedAt === null ? sync(thread.id, thread.providerId) : undefined);
  bb.events.on('thread.idle', ({ thread }) => thread.deletedAt === null ? sync(thread.id, thread.providerId) : undefined);
  bb.events.on('thread.failed', ({ thread }) => thread.deletedAt === null ? sync(thread.id, thread.providerId) : undefined);
  bb.events.on('thread.deleted', ({ thread }) => {
    const task = (pending.get(thread.id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (disposed) return;
      db.transaction(() => { for (const table of ['cache_events', 'cache_turns', 'cache_cursors', 'cache_statistics_versions']) db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(thread.id); })();
    });
    pending.set(thread.id, task);
    void task.finally(() => { if (pending.get(thread.id) === task) pending.delete(thread.id); }).catch(() => {});
    return task;
  });
  return { sync, session, turn };
}
