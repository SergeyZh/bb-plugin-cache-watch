import { afterEach, describe, expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PING } from './core';

type Rows = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>;
const threadId = 'thr_statistics123';
const thread = makeThreadResponse({ id: threadId, providerId: 'codex' });
const counts = (inputTokens: number, cachedInputTokens: number, outputTokens: number, cacheWriteInputTokens: number | undefined = 0) =>
  ({ inputTokens, cachedInputTokens, outputTokens, cacheWriteInputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens });
const request = (seq: number, model = 'gpt-6.1-sol', text = 'PRIVATE PROMPT') => ({ seq, type: 'client/turn/requested', data: {
  requestId: `r${seq}`, execution: { model, serviceTier: 'default' }, input: [{ type: 'text', text, mentions: [] }],
} });
const start = (seq: number, turnId: string) => ({ seq, type: 'turn/started', scope: { kind: 'turn', turnId } });
const usage = (seq: number, turnId: string, total: ReturnType<typeof counts>, last = total) => ({ seq,
  type: 'thread/tokenUsage/updated', scope: { kind: 'turn', turnId }, data: { providerThreadId: 'session1', tokenUsage: { total, last } } });
const done = (seq: number, turnId: string) => ({ seq, type: 'turn/completed', scope: { kind: 'turn', turnId }, data: { status: 'completed' } });
const rows = (data: unknown[]) => data.map(row => ({ createdAt: 1000, scope: { kind: 'thread' }, ...row as object })) as Rows;
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
async function setup(data: Rows, providerId = 'codex') {
  const host = createFakePluginHost({ pluginId: 'cache-watch', sdk: { threads: { get: async () => ({ ...thread, providerId }),
    events: { list: async (args: { afterSeq?: string; beforeSeq?: string; types?: readonly string[]; limit?: string; order?: string }) => {
      const filtered = data.filter(row => (!args.types || args.types.includes(row.type)) && row.seq > Number(args.afterSeq ?? 0)
        && row.seq < Number(args.beforeSeq ?? Infinity)).sort((a, b) => args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq);
      return filtered.slice(0, Number(args.limit ?? 100));
    } },
  } } });
  hosts.push(host); await plugin(host.bb); return host;
}
const twoTurns = () => rows([
  request(1), start(2, 't1'), usage(3, 't1', counts(100, 0, 10)), usage(4, 't1', counts(100, 0, 10)), done(5, 't1'),
  request(6, 'gpt-6.1-sol', PING), start(7, 't2'), usage(8, 't2', counts(400, 200, 30), counts(300, 200, 20)), done(9, 't2'),
]);

describe('durable session statistics', () => {
  it('backfills all turns, deduplicates reports and keeps history separate from the latest turn', async () => {
    const h = await setup(twoTurns());
    const result = await h.harness.behavior.callRpc('session', { threadId });
    expect(result).toMatchObject({ totalTurns: 2, keepaliveTurns: 1, input: { known: 400, unknownTurns: 0 },
      output: { known: 30 }, read: { known: 200 }, written: { known: 0 }, syncedThroughSeq: 9 });
    expect(await h.harness.behavior.callRpc('turn', { threadId, turnId: 't1' })).toMatchObject({ completed: true,
      turn: { firstReadTokens: 0, readTokens: 0, steps: [{ readTokens: 0 }] } });
    expect(await h.harness.behavior.callRpc('turn', { threadId, turnId: 't2' })).toMatchObject({ keepalive: true, turn: { firstReadTokens: 200 } });
    expect(await h.harness.behavior.callRpc('session', { threadId })).toEqual(result);
    expect(JSON.stringify(h.bb.storage.database().prepare('SELECT body FROM cache_events').all())).not.toContain('PRIVATE PROMPT');
  });
  it('survives plugin reloads and ingests new usage automatically without an open panel', async () => {
    const data = twoTurns();
    const h = await setup(data);
    await h.harness.behavior.emitThreadEvent('thread.idle', { thread, lastAssistantText: 'PRIVATE ANSWER' });
    const reloaded = await h.harness.lifecycle.reload(plugin); hosts.push(reloaded);
    expect(await reloaded.harness.behavior.callRpc('session', { threadId })).toMatchObject({ totalTurns: 2, input: { known: 400 } });
    data.push(...rows([request(10), start(11, 't3'), usage(12, 't3', counts(900, 600, 60), counts(500, 400, 30)), done(13, 't3')]));
    await reloaded.harness.behavior.emitThreadEvent('experimental_thread.events', { thread, sequence: 13 });
    expect(await reloaded.harness.behavior.callRpc('session', { threadId })).toMatchObject({ totalTurns: 3, input: { known: 900 }, read: { known: 600 } });
    expect(JSON.stringify(reloaded.bb.storage.database().prepare('SELECT body FROM cache_events').all())).not.toContain('PRIVATE ANSWER');
  });
  it('counts unreported token fields and unknown costs instead of silently zeroing them', async () => {
    const data = twoTurns();
    data.push(...rows([request(10, 'unknown-model'), start(11, 't3'), usage(12, 't3', counts(900, 600, 60), counts(500, 400, 30))]));
    const last = data[data.length - 1];
    if (last.type === 'thread/tokenUsage/updated') {
      delete last.data.tokenUsage.total.cacheWriteInputTokens;
      delete last.data.tokenUsage.last.cacheWriteInputTokens;
    }
    const h = await setup(data);
    expect(await h.harness.behavior.callRpc('session', { threadId })).toMatchObject({ totalTurns: 3,
      written: { known: 0, unknownTurns: 1 }, costMin: { unknownTurns: 1 }, input: { known: 900, unknownTurns: 0 } });
  });
  it('backfills more than 100 events and paginates historical turns without changing session totals', async () => {
    const data = rows(Array.from({ length: 60 }, (_, index) => {
      const base = index * 4;
      return [request(base + 1), start(base + 2, `t${index}`),
        usage(base + 3, `t${index}`, counts((index + 1) * 100, index * 10, (index + 1) * 10), counts(100, index ? 10 : 0, 10)), done(base + 4, `t${index}`)];
    }).flat());
    const h = await setup(data);
    const first = await h.harness.behavior.callRpc('session', { threadId }) as { turns: unknown[]; nextBeforeSeq: number; totalTurns: number };
    expect(first.turns).toHaveLength(50); expect(first.totalTurns).toBe(60);
    const next = await h.harness.behavior.callRpc('session', { threadId, beforeSeq: first.nextBeforeSeq });
    expect(next).toMatchObject({ totalTurns: 60, input: { known: 6000 }, nextBeforeSeq: null });
    expect((next as { turns: unknown[] }).turns).toHaveLength(10);
  });
});

it('keeps completed turns with no retained telemetry explicitly unknown and purges deleted sessions', async () => {
  const h = await setup(rows([request(1), start(2, 't1'), done(3, 't1')]));
  expect(await h.harness.behavior.callRpc('session', { threadId })).toMatchObject({
    totalTurns: 1, input: { known: 0, unknownTurns: 1 }, read: { known: 0, unknownTurns: 1 },
    turns: [{ completed: true, turn: { note: 'No usage reports available for this completed turn.' } }],
  });
  await h.harness.behavior.emitThreadEvent('thread.deleted', { thread });
  expect(h.bb.storage.database().prepare('SELECT count(*) AS count FROM cache_turns').get()).toEqual({ count: 0 });
  expect(h.bb.storage.database().prepare('SELECT count(*) AS count FROM cache_events').get()).toEqual({ count: 0 });
});

it('persists Claude Code token categories, write-range cost, pricing source and provider through reload and counter restarts', async () => {
  const claudeCounts = (input: number, read: number, write: number, output: number) => ({
    ...counts(input, read + write, output, write), cacheReadInputTokens: read,
  });
  const data = rows([
    request(1, 'claude-opus-5-5'), start(2, 't1'), usage(3, 't1', claudeCounts(100, 50000, 10000, 1000)), done(4, 't1'),
    request(5, 'claude-opus-5-5', PING), start(6, 't2'),
    usage(7, 't2', claudeCounts(200, 100000, 20000, 2000), claudeCounts(100, 50000, 10000, 1000)),
    usage(8, 't2', claudeCounts(200, 100000, 20000, 2000), claudeCounts(100, 50000, 10000, 1000)), done(9, 't2'),
    request(10, 'claude-opus-5-5'), start(11, 't3'), usage(12, 't3', claudeCounts(100, 50000, 10000, 1000)), done(13, 't3'),
  ]);
  const h = await setup(data, 'claude-code');
  await h.harness.behavior.emitThreadEvent('thread.idle', { thread: { ...thread, providerId: 'claude-code' }, lastAssistantText: null });
  const before = await h.harness.behavior.callRpc('session', { threadId });
  expect(before).toMatchObject({ providerId: 'claude-code', totalTurns: 3, keepaliveTurns: 1,
    input: { known: 300, unknownTurns: 0 }, output: { known: 3000 }, read: { known: 150000 }, written: { known: 30000 },
  });
  for (const saved of (before as { turns: unknown[] }).turns) expect(saved).toMatchObject({
    providerId: 'claude-code', turn: { firstReadTokens: null, readTokens: 50000, writeTokens: 10000 },
    cost: { providerId: 'claude-code', model: 'claude-opus-5-5', pricingLabel: 'Anthropic Standard API rates' },
  });
  const min = (before as { costMin: { known: number } }).costMin.known;
  expect(min).toBeCloseTo(0.2412);
  const stored = await h.harness.behavior.callRpc('turn', { threadId, turnId: 't2' }) as { turn: { steps: unknown[] }; cost: { minUsd: number; maxUsd: number; pricingUrl: string } };
  expect(stored.turn.steps).toHaveLength(1);
  expect(stored.cost.minUsd).toBeCloseTo(0.0804);
  expect(stored.cost.maxUsd).toBeCloseTo(0.1104);
  expect(stored.cost.pricingUrl).toContain('platform.claude.com');
  const reloaded = await h.harness.lifecycle.reload(plugin); hosts.push(reloaded);
  expect(await reloaded.harness.behavior.callRpc('session', { threadId })).toEqual(before);
  expect(await reloaded.harness.behavior.callRpc('turn', { threadId, turnId: 't2' })).toEqual(stored);
  // Upgrade already-saved unsupported-provider snapshots even without new events.
  const db = reloaded.bb.storage.database();
  db.prepare('DELETE FROM cache_statistics_versions').run();
  db.prepare("UPDATE cache_turns SET body=json_set(body, '$.cost.minUsd', NULL, '$.cost.note', 'Codex providers only')").run();
  expect(await reloaded.harness.behavior.callRpc('turn', { threadId, turnId: 't2' })).toEqual(stored);
});

it('persists Claude Code Telemetry request steps, the first cache hit and Anthropic costs across reload', async () => {
  const a = { ...counts(100, 50005, 20, 5), cacheReadInputTokens: 50000 };
  const total = { ...counts(200, 100010, 40, 10), cacheReadInputTokens: 100000 };
  const meta = (seq: number) => ({ seq, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
    data: { kind: 'claude-code-telemetry/usage', payload: { source: 'request', messageId: `msg-${seq}`, model: 'claude-opus-5-5', incomplete: false, counts: a } } });
  const data = rows([request(1, 'claude-opus-5-5'), start(2, 't1'), meta(3), usage(4, 't1', a), meta(5), usage(6, 't1', total, a), done(7, 't1')]);
  const h = await setup(data, 'claude-code-telemetry');
  const before = await h.harness.behavior.callRpc('turn', { threadId, turnId: 't1' });
  expect(before).toMatchObject({ providerId: 'claude-code-telemetry',
    turn: { firstReadTokens: 50000, inputTokens: 200, readTokens: 100000, writeTokens: 10,
      steps: [{ combined: false }, { combined: false }] },
    cost: { providerId: 'claude-code-telemetry', pricingLabel: 'Anthropic Standard API rates' },
  });
  expect((before as { cost: { minUsd: number } }).cost.minUsd).toBeGreaterThan(0);
  const reloaded = await h.harness.lifecycle.reload(plugin); hosts.push(reloaded);
  expect(await reloaded.harness.behavior.callRpc('turn', { threadId, turnId: 't1' })).toEqual(before);
});

it('backfills THREAD-scoped request metadata across page boundaries and a pre-telemetry cursor upgrade', async () => {
  const a = { ...counts(100, 0, 10, 0), cacheReadInputTokens: 0 };
  const meta = { seq: 100, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
    data: { kind: 'claude-code-telemetry/usage', payload: { source: 'request', messageId: 'real-request', model: 'claude-opus-5-5', incomplete: false, counts: a } } };
  const data = rows([request(1, 'claude-opus-5-5'), start(2, 't1'),
    ...Array.from({ length: 97 }, (_, index) => ({ seq: index + 3, type: 'thread/extensionState/updated', data: { kind: 'other-plugin/state', payload: 'PRIVATE EXTENSION' } })),
    meta, usage(101, 't1', a), done(102, 't1')]);
  const h = await setup(data, 'claude-code-telemetry');
  const before = await h.harness.behavior.callRpc('turn', { threadId, turnId: 't1' });
  expect(before).toMatchObject({ turn: { firstReadTokens: 0, steps: [{ source: 'request', messageId: 'real-request', model: 'claude-opus-5-5', incomplete: false }] } });
  const db = h.bb.storage.database();
  expect(JSON.stringify(db.prepare('SELECT body FROM cache_events').all())).not.toContain('PRIVATE EXTENSION');
  // Old collectors already advanced past these metadata but did not persist them.
  db.prepare("DELETE FROM cache_events WHERE json_extract(body, '$.type') = 'thread/extensionState/updated'").run();
  db.prepare('UPDATE cache_statistics_versions SET revision=1').run();
  const reloaded = await h.harness.lifecycle.reload(plugin); hosts.push(reloaded);
  expect(await reloaded.harness.behavior.callRpc('turn', { threadId, turnId: 't1' })).toEqual(before);
});
