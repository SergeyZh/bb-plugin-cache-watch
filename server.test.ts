import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse, makeMessageDispatchHookContext, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
import { PING, nextPingAt, type Watch } from './core';

const threadId = 'thr_test123';
const baseTime = new Date('2026-10-30T12:00:00Z').getTime();
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
async function setup() {
  let thread = makeThreadResponse({ id: threadId, status: 'idle', runtime: { displayStatus: 'idle' }, queuedMessageCount: 0, activeBackgroundAgentCount: 0, archivedAt: null, deletedAt: null });
  const host = createFakePluginHost({ pluginId: 'cache-watch', sdk: { threads: {
    get: async () => thread,
    events: { list: async () => [] },
    context: async () => ({ usage: null }),
    send: async () => ({ ok: true, delivery: 'sent' }),
    queuedMessages: { list: async () => [] },
  } } });
  hosts.push(host);
  await plugin(host.bb);
  return { ...host, setThread: (next: typeof thread) => { thread = next; }, thread: () => thread };
}
async function start(host: Awaited<ReturnType<typeof setup>>, extra = {}) {
  return host.harness.behavior.callRpc('start', { threadId, intervalMinutes: 4, durationHours: 6, ...extra });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(baseTime); });
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); vi.useRealTimers(); });

describe('Cache Watch lifecycle', () => {
  it('is opt-in and sends one bounded idle turn, without changing model or tools', async () => {
    const h = await setup();
    await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
    await start(h);
    vi.setSystemTime(baseTime + 240_000);
    await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
    expect(h.harness.inspection.sdk.callsTo('threads.send')[0]).toEqual([{ threadId, mode: 'start', originPluginId: 'cache-watch', input: [{ type: 'text', text: PING, mentions: [] }] }]);
    await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
    vi.setSystemTime(baseTime + 6 * 3_600_000);
    await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
  });
  it('skips busy threads, queued messages, and background agents', async () => {
    const h = await setup(); await start(h); vi.setSystemTime(baseTime + 240_000);
    const idle = h.thread();
    for (const patch of [{ status: 'active' as const }, { queuedMessageCount: 1 }, { activeBackgroundAgentCount: 1 }, { runtime: { displayStatus: 'waiting-for-host' as const } }]) {
      h.setThread({ ...idle, ...patch });
      await h.harness.behavior.runSchedule('keepalive');
    }
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('preserves the lease and last send across reload, then stops', async () => {
    const h = await setup(); await start(h); vi.setSystemTime(baseTime + 240_000);
    await h.harness.behavior.runSchedule('keepalive');
    const reloaded = await h.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    await reloaded.harness.behavior.runSchedule('keepalive');
    expect(reloaded.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
    await reloaded.harness.behavior.callRpc('stop', { threadId });
    vi.setSystemTime(baseTime + 500_000); await reloaded.harness.behavior.runSchedule('keepalive');
    expect(reloaded.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('pauses on ambiguous failure and never retries automatically', async () => {
    const h = await setup(); await start(h);
    h.harness.sdk.stub('threads.send', async () => { throw new Error('private network details'); });
    vi.setSystemTime(baseTime + 240_000); await h.harness.behavior.runSchedule('keepalive');
    vi.setSystemTime(baseTime + 500_000); await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
    expect(await h.harness.behavior.callRpc('list')).toEqual([expect.objectContaining({ disabled: true, error: expect.not.stringContaining('private') })]);
  });
  it('rejects stale or racing pings at the dispatch checkpoint', async () => {
    const h = await setup(); await start(h);
    const hook = h.harness.registrations.hooks['message.dispatch']!;
    const ctx = makeMessageDispatchHookContext({ thread: h.thread(), originPluginId: 'cache-watch', input: { text: PING }, attempt: 'start-turn' });
    expect(await hook(ctx)).toEqual({ action: 'proceed' });
    expect(await hook({ ...ctx, attempt: 'join-turn' })).toEqual(expect.objectContaining({ action: 'reject' }));
    await h.harness.behavior.callRpc('stop', { threadId });
    expect(await hook(ctx)).toEqual(expect.objectContaining({ action: 'reject' }));
  });
  it('never intercepts user or other-plugin messages, regardless of lease or thread state', async () => {
    const h = await setup();
    const hook = h.harness.registrations.hooks['message.dispatch']!;
    for (const lease of ['absent', 'enabled', 'expired', 'stopped']) {
      if (lease === 'enabled') await start(h);
      if (lease === 'expired') vi.setSystemTime(baseTime + 7 * 3_600_000);
      if (lease === 'stopped') await h.harness.behavior.callRpc('stop', { threadId });
      for (const originPluginId of [null, 'mixed', 'another-plugin']) {
        for (const attempt of ['start-turn', 'join-turn'] as const) {
          for (const text of ['Ordinary user prompt', PING]) {
            const ctx = makeMessageDispatchHookContext({
              thread: { ...h.thread(), status: 'active', runtime: { displayStatus: 'active' } },
              originPluginId, attempt, input: { text },
            });
            expect(await hook(ctx)).toEqual({ action: 'proceed' });
          }
        }
      }
    }
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('validates intervals and durations at RPC and CLI boundaries', async () => {
    const h = await setup();
    await expect(start(h, { intervalMinutes: 0 })).rejects.toThrow();
    await expect(start(h, { durationHours: 100 })).rejects.toThrow();
    expect((await h.harness.behavior.runCli(['start', threadId, '--minutes', 'NaN'])).exitCode).toBe(1);
    expect(await h.harness.behavior.callRpc('list')).toEqual([]);
  });
  it('keeps missing telemetry unknown and does not warm on status reads', async () => {
    const h = await setup();
    expect(await h.harness.behavior.callRpc('status', { threadId })).toEqual(expect.objectContaining({ sample: null, estimatedExpiresAt: null }));
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('postpones the next ping after reported normal activity', () => {
    const watch: Watch = { threadId, intervalMinutes: 4, armedAt: baseTime, until: baseTime + 3_600_000, lastAttemptAt: null, sent: 0, disabled: false, error: null };
    expect(nextPingAt(watch, { at: baseTime + 180_000, readTokens: 0, writeTokens: null, inputTokens: 100, ttlMs: null })).toBe(baseTime + 420_000);
  });
  it('does not send when disposed while provider telemetry is being fetched', async () => {
    const h = await setup(); await start(h); vi.setSystemTime(baseTime + 240_000);
    let release!: (value: never[]) => void;
    const pending = new Promise<never[]>(resolve => { release = resolve; });
    h.harness.sdk.stub('threads.events.list', () => pending);
    const tick = h.harness.behavior.runSchedule('keepalive');
    // Let the serialized sweep enter its provider read before disposing.
    await Promise.resolve(); await Promise.resolve();
    await h.harness.lifecycle.dispose();
    release([]); await tick;
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('reports partial hits and TTL telemetry without claiming a live cache', async () => {
    const h = await setup();
    h.harness.sdk.stub('threads.events.list', async () => [{ type: 'thread/tokenUsage/updated', createdAt: baseTime,
      data: { tokenUsage: { last: { inputTokens: 1500, cachedInputTokens: 1000, cacheWriteInputTokens: 500 }, promptCacheTtlMs: 300_000 } } }]);
    expect(await h.harness.behavior.callRpc('status', { threadId })).toEqual(expect.objectContaining({
      sample: { at: baseTime, inputTokens: 1500, readTokens: 1000, writeTokens: 500, ttlMs: 300_000 },
      estimatedExpiresAt: baseTime + 300_000,
      expirySource: 'provider',
    }));
  });
  it('uses the marked 30-minute fallback for native and Central Codex cache activity', async () => {
    const h = await setup();
    h.harness.sdk.stub('threads.events.list', async () => [{ type: 'thread/tokenUsage/updated', createdAt: baseTime,
      data: { tokenUsage: { last: { inputTokens: 1500, cachedInputTokens: 1000, cacheWriteInputTokens: 0 } } } }]);
    for (const providerId of ['codex', 'central-codex']) {
      h.setThread({ ...h.thread(), providerId });
      expect(await h.harness.behavior.callRpc('status', { threadId })).toEqual(expect.objectContaining({
        estimatedExpiresAt: baseTime + 1_800_000, expirySource: 'codex-assumption',
        sample: expect.objectContaining({ ttlMs: null }),
      }));
    }
    expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  });
  it('does not infer expiry from uncached usage or apply the Codex fallback to other providers', async () => {
    const h = await setup();
    h.setThread({ ...h.thread(), providerId: 'codex' });
    h.harness.sdk.stub('threads.events.list', async () => [{ type: 'thread/tokenUsage/updated', createdAt: baseTime,
      data: { tokenUsage: { last: { inputTokens: 1500, cachedInputTokens: 0, cacheWriteInputTokens: 0 } } } }]);
    expect(await h.harness.behavior.callRpc('status', { threadId })).toEqual(expect.objectContaining({
      estimatedExpiresAt: null, expirySource: null,
    }));
    h.setThread({ ...h.thread(), providerId: 'claude-code' });
    h.harness.sdk.stub('threads.events.list', async () => [{ type: 'thread/tokenUsage/updated', createdAt: baseTime,
      data: { tokenUsage: { last: { inputTokens: 1500, cachedInputTokens: 1000, cacheWriteInputTokens: 0 } } } }]);
    expect(await h.harness.behavior.callRpc('status', { threadId })).toEqual(expect.objectContaining({
      estimatedExpiresAt: null, expirySource: null,
    }));
  });
  it('cancels a ping deferred by another plugin', async () => {
    const h = await setup(); await start(h);
    h.harness.sdk.stub('threads.send', async () => ({ ok: true, delivery: 'queued', queuedMessage: { id: 'q1' } }));
    h.harness.sdk.stub('threads.queuedMessages.delete', async () => ({ ok: true }));
    vi.setSystemTime(baseTime + 240_000); await h.harness.behavior.runSchedule('keepalive');
    expect(h.harness.inspection.sdk.callsTo('threads.queuedMessages.delete')).toEqual([[{ threadId, queuedMessageId: 'q1' }]]);
    expect(await h.harness.behavior.callRpc('list')).toEqual([expect.objectContaining({ sent: 0 })]);
  });
  it('uses public SDK imports only', async () => {
    const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^vitest(?:\/config)?$/, /^react(?:-dom)?$/, /^@testing-library\/react$/, /^@\/components\/ui\//, /^@radix-ui\/react-(?:slot|checkbox|dialog)$/, /^(?:class-variance-authority|clsx|tailwind-merge)$/] });
    expect(result.violations).toEqual([]); expect(result.privateDependencies).toEqual([]);
  });
});
