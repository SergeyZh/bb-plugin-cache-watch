import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { PING, watchInput, watchSchema, sampleSchema, nextPingAt, estimateExpiry, eligible, type Sample, type Watch } from './core';

const idInput = z.object({ threadId: watchInput.shape.threadId }).strict();
const statusSchema = z.object({
  threadId: z.string(), title: z.string(), providerId: z.string(), status: z.string(),
  sample: sampleSchema.nullable(), estimatedExpiresAt: z.number().nullable(),
  expirySource: z.enum(['provider', 'codex-assumption']).nullable(),
  watch: watchSchema.nullable(), nextPingAt: z.number().nullable(),
});
export type CacheStatus = z.infer<typeof statusSchema>;
export const rpcContract = defineRpcContract({
  status: { input: idInput, output: statusSchema },
  list: { input: z.null(), output: z.array(watchSchema) },
  start: { input: watchInput, output: watchSchema },
  stop: { input: idInput, output: z.object({ stopped: z.boolean() }) },
});

export default async function plugin(bb: BbPluginApi) {
  const KEY = 'watches-v1';
  // Migrate persisted fixed-interval leases to expiry scheduling on reload.
  const storedWatch = watchSchema.extend({ intervalMinutes: z.number().int().min(2).max(55).optional() })
    .transform(({ intervalMinutes: _legacyInterval, ...watch }) => watch);
  const parsed = z.array(storedWatch).max(50).safeParse(await bb.storage.kv.get(KEY) ?? []);
  if (!parsed.success) throw new Error('Invalid Cache Watch storage; refusing to resume pings.');
  let watches: Watch[] = parsed.data;
  let disposed = false;
  // Serialize CLI/RPC mutations and sweeps so stop cannot race a new send.
  let tail = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  async function save() {
    await bb.storage.kv.set(KEY, watches);
    bb.realtime.publish('changed', null);
  }
  async function sample(threadId: string): Promise<Sample | null> {
    const rows = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '1', types: ['thread/tokenUsage/updated'] });
    const row = rows[0];
    if (!row || row.type !== 'thread/tokenUsage/updated') return null;
    const usage = row.data.tokenUsage;
    return {
      at: row.createdAt, readTokens: usage.last.cacheReadInputTokens ?? usage.last.cachedInputTokens,
      writeTokens: usage.last.cacheWriteInputTokens ?? null,
      inputTokens: usage.last.inputTokens, ttlMs: usage.promptCacheTtlMs ?? null,
    };
  }
  async function status(threadId: string): Promise<CacheStatus> {
    const [thread, last, context] = await Promise.all([
      bb.sdk.threads.get({ threadId }), sample(threadId), bb.sdk.threads.context({ threadId }),
    ]);
    const watch = watches.find(w => w.threadId === threadId) ?? null;
    const expiry = estimateExpiry(thread.providerId, last, context.usage?.compactionOfferAt);
    const due = watch ? nextPingAt(watch, expiry.at) : null;
    return {
      threadId, title: thread.title ?? thread.titleFallback ?? threadId,
      providerId: thread.providerId, status: thread.runtime.displayStatus,
      sample: last, estimatedExpiresAt: expiry.at,
      expirySource: expiry.source,
      watch, nextPingAt: watch && !watch.disabled && watch.until > Date.now() && expiry.at !== null && expiry.at > Date.now() && due !== null && due < watch.until ? due : null,
    };
  }
  async function start(input: z.infer<typeof watchInput>): Promise<Watch> {
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) throw new Error('Cannot watch an archived or deleted thread.');
    if (!watches.some(w => w.threadId === input.threadId) && watches.length >= 50) throw new Error('Limit: 50 watches. Stop another watch first.');
    const now = Date.now();
    const watch: Watch = { threadId: input.threadId,
      armedAt: now, until: now + input.durationHours * 3_600_000,
      lastAttemptAt: null, sent: 0, error: null, disabled: false };
    watches = [...watches.filter(w => w.threadId !== input.threadId), watch];
    await save();
    return watch;
  }
  async function stop(threadId: string) {
    const oldLength = watches.length;
    watches = watches.filter(w => w.threadId !== threadId);
    await save();
    // Cancel any of our pings deferred by another plugin's admission policy.
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    for (const row of queued) {
      if (row.originPluginId === bb.pluginId && row.content.length === 1 && row.content[0]?.type === 'text' && row.content[0].text === PING)
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
    }
    return { stopped: watches.length !== oldLength };
  }
  bb.rpc.register(rpcContract, {
    status: ({ threadId }) => status(threadId),
    list: () => watches,
    start: input => serial(() => start(input)),
    stop: ({ threadId }) => serial(() => stop(threadId)),
  });

  // If a user starts work between our eligibility check and dispatch, reject
  // instead of steering or queuing the ping behind that work. Recheck leases
  // on every admission attempt (including waits held by other plugins).
  bb.experimental_hooks.on('message.dispatch', ctx => {
    if (ctx.originPluginId !== bb.pluginId || ctx.input.text !== PING) return { action: 'proceed' };
    const watch = watches.find(w => w.threadId === ctx.thread.id);
    if (disposed || !watch || watch.disabled || watch.until <= Date.now() || ctx.attempt !== 'start-turn' || !eligible(ctx.thread))
      return { action: 'reject', message: 'Cache Watch ping cancelled: lease expired or thread is busy.' };
    return { action: 'proceed' };
  });

  bb.background.schedule('keepalive', '* * * * *', () => serial(async () => {
    for (const watch of watches) {
      if (disposed) return;
      if (watch.disabled || watch.until <= Date.now()) continue;
      try {
        const [thread, last, context] = await Promise.all([bb.sdk.threads.get({ threadId: watch.threadId }), sample(watch.threadId), bb.sdk.threads.context({ threadId: watch.threadId })]);
        if (disposed) return;
        if (thread.archivedAt !== null || thread.deletedAt !== null || thread.status === 'error') {
          watch.disabled = true;
          watch.error = 'Stopped: thread archived, deleted, or failed.';
          await save();
          continue;
        }
        const expiry = estimateExpiry(thread.providerId, last, context.usage?.compactionOfferAt);
        const due = nextPingAt(watch, expiry.at);
        if (!eligible(thread) || expiry.at === null || expiry.at <= Date.now() || due === null || due > Date.now()) continue;
        // Persist before sending: a restart must not replay an uncertain send.
        watch.lastAttemptAt = Date.now();
        await save();
        if (disposed) return;
        const result = await bb.sdk.threads.send({ threadId: watch.threadId, mode: 'start',
          originPluginId: bb.pluginId, input: [{ type: 'text', text: PING, mentions: [] }] });
        if (result.delivery === 'queued') {
          await bb.sdk.threads.queuedMessages.delete({ threadId: watch.threadId, queuedMessageId: result.queuedMessage.id });
          watch.error = 'Ping deferred by BB; cancelled to avoid a stale keepalive.';
        } else {
          watch.sent += 1;
          watch.error = null;
        }
        await save();
      } catch {
        // Do not retry ambiguous network failures: the turn may have started.
        watch.disabled = true;
        watch.error = 'Paused after an API/dispatch error. Inspect the thread, then enable again.';
        await save();
      }
    }
  }));
  bb.onDispose(() => { disposed = true; });

  const usage = 'bb cache-watch status <thread-id> [--json]\nbb cache-watch list [--json]\nbb cache-watch start <thread-id> [--hours 6] [--json]\nbb cache-watch stop <thread-id> [--json]\nPings are ordinary paid turns, visible in the transcript. TTL is an estimate.';
  bb.cli.register({
    name: 'cache-watch', summary: 'Inspect cache usage and opt in to bounded keepalive turns',
    commands: ['status', 'list', 'start', 'stop'].map(name => ({ name, summary: `${name} cache watch`, usage: `bb cache-watch ${name} [--help]` })),
    async run(argv) {
      if (!argv.length || argv.includes('--help') || argv[0] === 'help') return { exitCode: 0, stdout: usage };
      try {
        const json = argv.includes('--json');
        const args = argv.filter(x => x !== '--json');
        const [command, threadId, ...flags] = args;
        let result: unknown;
        if (command === 'list' && args.length === 1) result = watches;
        else if (command === 'status' && args.length === 2) result = await status(idInput.parse({ threadId }).threadId);
        else if (command === 'stop' && args.length === 2) result = await serial(() => stop(idInput.parse({ threadId }).threadId));
        else if (command === 'start') {
          const options: Record<string, number> = {};
          for (let i = 0; i < flags.length; i += 2) {
            const flag = flags[i];
            if (flag !== '--hours' || flags[i + 1] === undefined || flag in options) throw new Error(usage);
            options[flag] = Number(flags[i + 1]);
          }
          const input = watchInput.parse({ threadId, durationHours: options['--hours'] });
          result = await serial(() => start(input));
        } else throw new Error(usage);
        return { exitCode: 0, stdout: JSON.stringify(result, null, json ? undefined : 2) };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : 'Cache Watch failed.' };
      }
    },
  });
}
