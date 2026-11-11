// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { loadPluginApp, mountPluginContentScripts, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import appDefinition from './app';
import { definePluginApp, type PluginCommandRegistration } from '@get-bb/plugin-sdk/app';
import { experimental_makePanelController } from '@get-bb/plugin-sdk/testing';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { cacheIsVisible, remainingTime } from './thread-cache';

const unmounts: (() => void)[] = [];
afterEach(() => { for (const unmount of unmounts.splice(0)) unmount(); vi.useRealTimers(); });
it('loads the registered page, shows unknown cache state, and requires opt-in', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const starts: unknown[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, {
    context: { projectId: null, threadId: 'thr_demo123' },
    rpc: {
      list: () => [],
      status: () => ({ threadId: 'thr_demo123', title: 'Demo thread', providerId: 'central-codex', status: 'idle', sample: null, estimatedExpiresAt: null, watch: null, nextPingAt: null }),
      start: (input: unknown) => { starts.push(input); return { threadId: 'thr_demo123', armedAt: Date.now(), until: Date.now() + 21_600_000, lastAttemptAt: null, sent: 0, error: null, disabled: false }; },
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText('Demo thread')).toBeTruthy();
  expect(await slot.findByText('Keepalive uses ordinary paid turns')).toBeTruthy();
  expect(slot.getByLabelText('Keep alive for (hours)').getAttribute('step')).toBe('1');
  expect(starts).toEqual([]);
  fireEvent.click(await slot.findByRole('button', { name: 'Enable paid keepalive' }));
  await waitFor(() => expect(starts).toEqual([{ threadId: 'thr_demo123', durationHours: 6 }]));
});
it('shows RPC failures and leaves the stop control usable', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, {
    context: { projectId: null, threadId: 'thr_demo123' },
    rpc: { list: () => [], status: () => { throw new Error('Provider unavailable'); } },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect((await slot.findByRole('alert')).textContent).toContain('Provider unavailable');
  expect((await slot.findByRole('button', { name: 'Stop keepalive' })).hasAttribute('disabled')).toBe(false);
});

function cacheStatus(threadId: string, readTokens = 14590) {
  return {
    threadId, title: 'Test thread', providerId: 'central-codex', status: 'idle',
    sample: { at: 1793390345316, readTokens, writeTokens: 51, inputTokens: 14644, ttlMs: null },
    turn: { turnId: 'turn1', readTokens, writeTokens: 51, firstReadTokens: readTokens, note: null,
      steps: [{ seq: 1, at: 1793390345316, readTokens, writeTokens: 51, combined: false }] },
    estimatedExpiresAt: null, watch: null, nextPingAt: null,
  };
}

it('binds the thread card to its pane and refreshes telemetry without enabling keepalive', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  let reads = 14590;
  const slot = renderSlot(app.threadContextCardSections[0]!, {
    threadId: 'thr_pane123', projectId: 'proj_test', environment: null,
  }, {
    context: { projectId: 'proj_other', threadId: 'thr_other123' },
    rpc: { status: (input: unknown) => cacheStatus((input as { threadId: string }).threadId, reads) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText((14590).toLocaleString())).toBeTruthy();
  expect(await slot.findByText('51')).toBeTruthy();
  expect(await slot.findByText('Unknown')).toBeTruthy();
  expect(slot.getByText('TTL not reported').className).toContain('text-muted-foreground');
  expect(slot.inspection.rpcCalls.every(call => call.method === 'status' && (call.input as { threadId: string }).threadId === 'thr_pane123')).toBe(true);
  reads = 15000;
  await slot.behavior.emitRealtime('changed', null);
  expect(await slot.findByText((15000).toLocaleString())).toBeTruthy();
  reads = 16000;
  fireEvent.click(await slot.findByRole('button', { name: 'Refresh cache usage' }));
  expect(await slot.findByText((16000).toLocaleString())).toBeTruthy();
  expect(slot.inspection.rpcCalls.every(call => call.method === 'status')).toBe(true);
});

it('keeps missing telemetry distinct from zero and retains a report on refresh failure', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  let fail = false;
  const slot = renderSlot(app.threadContextCardSections[0]!, {
    threadId: 'thr_empty123', projectId: 'proj_test', environment: null,
  }, {
    rpc: { status: (input: unknown) => {
      const { threadId } = input as { threadId: string };
      if (fail) throw new Error('Provider unavailable');
      return { ...cacheStatus(threadId, 0), sample: { ...cacheStatus(threadId).sample, readTokens: 0, writeTokens: null }, turn: { ...cacheStatus(threadId, 0).turn, writeTokens: null, steps: [{ ...cacheStatus(threadId, 0).turn.steps[0], writeTokens: null }] } };
    } },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText('0')).toBeTruthy();
  expect(await slot.findByText('Not reported')).toBeTruthy();
  fail = true;
  fireEvent.click(await slot.findByRole('button', { name: 'Refresh cache usage' }));
  expect((await slot.findByRole('status')).textContent).toContain('Showing the last report');
  expect(slot.getByText('0')).toBeTruthy();
});

it('registers a compact thread summary and shows details only when expanded', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const segment = app.threadContextSegments[0]!;
  let toggles = 0;
  const props = {
    threadId: 'thr_banner123', projectId: 'proj_test', environment: null,
    segments: [], isExpanded: false, onToggle: () => { toggles += 1; },
  };
  const options = { rpc: { status: (input: unknown) => cacheStatus((input as { threadId: string }).threadId) } };
  const summary = renderSlot({ component: segment.action! }, props, options);
  unmounts.push(() => summary.lifecycle.unmount());
  fireEvent.click(await summary.findByRole('button', { name: /Cache:.*read.*written/ }));
  expect(toggles).toBe(1);
  const collapsed = renderSlot({ component: segment.details! }, props, options);
  unmounts.push(() => collapsed.lifecycle.unmount());
  expect(collapsed.queryByLabelText('Thread cache usage')).toBeNull();
  const expanded = renderSlot({ component: segment.details! }, { ...props, isExpanded: true }, options);
  unmounts.push(() => expanded.lifecycle.unmount());
  expect(await expanded.findByText((14590).toLocaleString())).toBeTruthy();
});

it('distinguishes unknown expiry, remaining time, and an elapsed estimate', () => {
  const now = 1793390345316;
  expect(remainingTime(null, now)).toBe('TTL not reported');
  expect(remainingTime(now + 3_661_000, now)).toBe('~1h 1m 01s left');
  expect(remainingTime(now + 1, now)).toBe('~0m 01s left');
  expect(remainingTime(now, now)).toBe('Estimated TTL elapsed');
  expect(remainingTime(now - 60_000, now)).toBe('Estimated TTL elapsed');
});

it('counts down locally each second and stops at an elapsed estimate', async () => {
  vi.useFakeTimers();
  const now = 1793390345316;
  vi.setSystemTime(now);
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const props = { threadId: 'thr_clock123', projectId: 'proj_test', environment: null, segments: [], isExpanded: false, onToggle() {} };
  let requests = 0;
  let slot!: ReturnType<typeof renderSlot>;
  await act(async () => {
    slot = renderSlot({ component: app.threadContextSegments[0]!.action! }, props, {
      rpc: { status: () => { requests += 1; return { ...cacheStatus(props.threadId), estimatedExpiresAt: now + 61_000, expirySource: 'codex-assumption' }; } },
    });
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(slot.getByRole('button', { name: /~1m 01s left/ })).toBeTruthy();
  expect(slot.getByText(/~1m 01s left.*assumed 30m/).className).toContain('text-green-700');
  expect(slot.getByText(/~1m 01s left.*assumed 30m/).className).toContain('font-mono');
  const initialRequests = requests;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(slot.getByRole('button', { name: /~1m 00s left/ })).toBeTruthy();
  expect(requests).toBe(initialRequests);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(slot.getByRole('button', { name: /Estimated TTL elapsed/ })).toBeTruthy();
  expect(slot.getByText(/Estimated TTL elapsed.*assumed 30m/).className).toContain('text-red-700');
});

for (const surface of ['card', 'banner'] as const) {
  it(`manages the pane session's keepalive from the ${surface}`, async () => {
    const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
    const threadId = 'thr_controls123';
    let watch: Record<string, unknown> | null = null;
    const props = {
      threadId, projectId: 'proj_test', environment: null, segments: [], isExpanded: true, onToggle() {},
    };
    const options = {
      context: { projectId: 'proj_other', threadId: 'thr_other123' },
      rpc: {
        status: () => ({ ...cacheStatus(threadId), watch, nextPingAt: watch ? Date.now() + 60_000 : null }),
        start: (input: unknown) => { watch = { threadId, until: Date.now() + 7_200_000, sent: 0, disabled: false }; return watch; },
        stop: () => { watch = null; return { stopped: true }; },
      },
    };
    const slot = surface === 'card' ? renderSlot(app.threadContextCardSections[0]!, props, options)
      : renderSlot({ component: app.threadContextSegments[0]!.details! }, props, options);
    unmounts.push(() => slot.lifecycle.unmount());
    expect(await slot.findByText('Keepalive: Off')).toBeTruthy();
    expect(slot.getByRole('spinbutton', { name: 'Keepalive duration (hours)' }).getAttribute('step')).toBe('1');
    fireEvent.change(slot.getByRole('spinbutton', { name: 'Keepalive duration (hours)' }), { target: { value: '2' } });
    fireEvent.click(slot.getByRole('button', { name: 'Enable paid keepalive' }));
    expect(await slot.findByText('Keepalive: Enabled')).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter(c => c.method === 'start').map(c => c.input)).toEqual([{ threadId, durationHours: 2 }]);
    fireEvent.click(slot.getByRole('button', { name: 'Renew paid keepalive' }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(c => c.method === 'start')).toHaveLength(2));
    await waitFor(() => expect(slot.getByRole('button', { name: 'Stop keepalive' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(slot.getByRole('button', { name: 'Stop keepalive' }));
    expect(await slot.findByText('Keepalive: Off')).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter(c => c.method === 'stop').map(c => c.input)).toEqual([{ threadId }]);
  });
}

async function palette() {
  const commands: PluginCommandRegistration[] = [];
  const app = await loadPluginApp(definePluginApp(builder => appDefinition.setup({
    ...builder,
    commands: { register(command) { commands.push(command); builder.commands.register(command); } },
  })));
  return { app, commands, context: { threadId: 'thr_palette123', projectId: 'proj_test', experimental_panel: experimental_makePanelController() } };
}

it('runs palette keepalive commands directly for the invocation session and cleans up on unmount', async () => {
  vi.mocked(toast).mockClear(); vi.mocked(toast.success).mockClear();
  const { app, commands, context } = await palette();
  expect(commands.map(c => c.id)).toEqual(['keepalive-status', 'keepalive-start', 'keepalive-renew', 'keepalive-stop']);
  expect(commands.every(c => !c.isAvailable!(context))).toBe(true);
  const slot = renderSlot(app.appOverlays[0]!, {}, {
    context: { threadId: 'thr_other123', projectId: null },
    rpc: {
      status: () => ({ ...cacheStatus(context.threadId), title: 'Palette session' }),
      start: () => ({ until: Date.now() + 21_600_000 }),
      stop: () => ({ stopped: true }),
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(commands.every(c => c.isAvailable!(context))).toBe(true);
  for (const command of commands) {
    expect(command.isAvailable!({ ...context, threadId: null })).toBe(false);
    await act(async () => { await command.run({ ...context, threadId: null }); });
  }
  expect(slot.inspection.rpcCalls).toEqual([]);
  for (const command of commands) await act(async () => { await command.run(context); });
  expect(slot.inspection.rpcCalls.map(c => [c.method, c.input])).toEqual([
    ['status', { threadId: context.threadId }],
    ['start', { threadId: context.threadId, durationHours: 6 }],
    ['start', { threadId: context.threadId, durationHours: 6 }],
    ['stop', { threadId: context.threadId }],
  ]);
  expect(toast).toHaveBeenCalledWith('Keepalive: Off', expect.objectContaining({ description: 'Palette session' }));
  expect(toast.success).toHaveBeenCalledWith('Keepalive stopped', expect.anything());
  slot.lifecycle.unmount();
  expect(commands.every(c => !c.isAvailable!(context))).toBe(true);
});

it('reports palette RPC failures and allows another command afterward', async () => {
  vi.mocked(toast.error).mockClear();
  const { app, commands, context } = await palette();
  const slot = renderSlot(app.appOverlays[0]!, {}, {
    rpc: { status: () => { throw new Error('Provider unavailable'); }, stop: () => ({ stopped: true }) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  await act(async () => { await commands[0]!.run(context); });
  expect(toast.error).toHaveBeenCalledWith('Keepalive command failed', { description: `${context.threadId}: Provider unavailable` });
  await act(async () => { await commands[3]!.run(context); });
  expect(slot.inspection.rpcCalls.map(c => c.method)).toEqual(['status', 'stop']);
});

it('keeps cost and savings in expanded details and omits cost from the summary', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const cost = { model: 'gpt-6.1-sol', turnId: 'turn1', minUsd: 0.0258, maxUsd: 0.0258,
    readSavingsUsd: 0.0342, hitRate: 0.9, inputTokens: 20000, outputTokens: 2000,
    pricingDate: '2026-11-01', note: 'Standard API equivalent; not a bill.' };
  const options = { rpc: { status: () => ({ ...cacheStatus('thr_demo123'), cost }) } };
  const card = renderSlot(app.threadContextCardSections[0]!, {
    threadId: 'thr_demo123', projectId: 'proj_test', environment: null,
  }, options);
  unmounts.push(() => card.lifecycle.unmount());
  expect(await card.findByText('$0.0258')).toBeTruthy();
  expect(card.getByText('$0.0342')).toBeTruthy();
  expect(card.getByText('90.0%')).toBeTruthy();
  expect(card.getByText('Standard API equivalent; not a bill.')).toBeTruthy();
  const summary = renderSlot({ component: app.threadContextSegments[0]!.action! }, {
    threadId: 'thr_demo123', projectId: 'proj_test', environment: null,
    segments: [], isExpanded: false, onToggle: () => {},
  }, options);
  unmounts.push(() => summary.lifecycle.unmount());
  const button = await summary.findByRole('button', { name: /Cache:.*read.*written/ });
  expect(button.textContent).not.toMatch(/hit|miss/);
  expect(button.textContent).not.toContain('$');
  expect(button.title).not.toContain('$');
  expect(card.inspection.rpcCalls.every(call => call.method === 'status')).toBe(true);
});

it('derives hit/miss from reported reads independently of writes and estimated expiry', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const props = { threadId: 'thr_result123', projectId: 'proj_test', environment: null,
    segments: [], isExpanded: true, onToggle() {} };
  for (const [reads, expiresAt, expected] of [
    [1, Date.now() - 1000, 'hit'],
    [0, Date.now() + 60000, 'miss'],
  ] as const) {
    const slot = renderSlot({ component: app.threadContextSegments[0]!.details! }, props, {
      rpc: { status: () => ({ ...cacheStatus(props.threadId, reads), estimatedExpiresAt: expiresAt }) },
    });
    unmounts.push(() => slot.lifecycle.unmount());
    expect(await slot.findByText(expected === 'hit' ? 'Yes — provider reported cache reads' : 'No — provider reported zero cache reads')).toBeTruthy();
    slot.lifecycle.unmount();
  }
  const missing = renderSlot({ component: app.threadContextSegments[0]!.details! }, props, {
    rpc: { status: () => ({ ...cacheStatus(props.threadId), sample: null, turn: null }) },
  });
  unmounts.push(() => missing.lifecycle.unmount());
  expect(await missing.findByText('Not reported by provider')).toBeTruthy();
});

it('keeps rounded formulas in a bounded scroll area without a redundant close button', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const props = { threadId: 'thr_breakdown123', projectId: 'proj_test', environment: null,
    segments: [], isExpanded: true, onToggle: vi.fn() };
  const status = { ...cacheStatus(props.threadId, 10), turn: {
    turnId: 't1', firstReadTokens: 0, readTokens: 30855, writeTokens: 0, note: null,
    steps: [0, 20345, 10510].map((readTokens, index) => ({ seq: index + 1, at: 1000,
      readTokens, writeTokens: 0, combined: false })),
  } };
  const options = { rpc: { status: () => status } };
  const summary = renderSlot({ component: app.threadContextSegments[0]!.action! }, props, options);
  unmounts.push(() => summary.lifecycle.unmount());
  expect(await summary.findByRole('button', { name: /Cache: 30.9K read · 0 written/i })).toBeTruthy();
  const details = renderSlot({ component: app.threadContextSegments[0]!.details! }, props, options);
  unmounts.push(() => details.lifecycle.unmount());
  expect(await details.findByText('Read (≈): 0k + 20k + 11k = 31k')).toBeTruthy();
  expect(details.getByText('Written (≈): 0k + 0k + 0k = 0k')).toBeTruthy();
  expect(details.getByText('Cache used (first request)')).toBeTruthy();
  expect(details.getByText('No — provider reported zero cache reads')).toBeTruthy();
  expect(details.queryByRole('table')).toBeNull();
  expect(details.queryByRole('button', { name: 'Close cache details' })).toBeNull();
  expect(details.getByRole('region', { name: 'Cache details' }).style.maxHeight).toBe('min(50dvh, 28rem)');
});

function savedTurn(turnId = 'turn1') {
  return { turnId, startSeq: 2, startedAt: 1000, updatedAt: 2000, completed: true, keepalive: false,
    turn: { ...cacheStatus('thr_demo123', 8000).turn, turnId, inputTokens: 10000, outputTokens: 1000 },
    cost: { model: 'gpt-6.1-sol', turnId, minUsd: 0.0148, maxUsd: 0.0148, readSavingsUsd: 0.0152,
      hitRate: 0.8, inputTokens: 10000, outputTokens: 1000, pricingDate: '2026-11-01', note: 'Standard API equivalent; not a bill.' } };
}

it('adds separate assistant metadata for the specific turn and opens its saved details', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const registration = app.messageMetadata[0]!;
  expect(registration.placement).toBe('actionRow');
  const slot = renderSlot(registration, { message: { id: 'message-old', threadId: 'thr_demo123', turnId: 'turn-old', role: 'assistant', createdAt: 1000 } }, {
    rpc: { turn: (input: unknown) => savedTurn((input as { turnId: string }).turnId) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const button = await slot.findByRole('button', { name: /Turn cache statistics: Cache · first: hit/ });
  fireEvent.click(button);
  expect(await slot.findByRole('dialog')).toBeTruthy();
  expect(slot.getByText('Standard API equivalent; not a bill.')).toBeTruthy();
  expect(slot.inspection.rpcCalls.every(call => call.method === 'turn' && (call.input as { turnId: string }).turnId === 'turn-old')).toBe(true);
});

it('shows how much of the first request was cached and how many requests a turn made', async () => {
  const { SessionStatisticsPanel } = await import('./statistics-ui');
  const step = { seq: 1, at: 1000, inputTokens: 2, outputTokens: 8, readTokens: 13220, writeTokens: 19196,
    source: 'request' as const, messageId: 'msg-1', model: 'claude-sonnet-5-5', combined: false, incomplete: false };
  const saved = { ...savedTurn('new-session'), providerId: 'claude-code-telemetry', turn: {
    turnId: 'new-session', inputTokens: 4, outputTokens: 596, readTokens: 45636, writeTokens: 22250,
    firstReadTokens: 13220, firstPromptTokens: 32418, note: null,
    steps: [step, { ...step, seq: 2, messageId: 'msg-2', readTokens: 32416, writeTokens: 3054 },
      { ...step, seq: 3, source: 'aggregate-remainder' as const, messageId: null, model: null, readTokens: 0, writeTokens: 0, combined: true, incomplete: true }] } };
  const total = { known: 0, unknownTurns: 0 };
  const slot = renderSlot({ component: SessionStatisticsPanel }, { threadId: 'thr_demo123' }, {
    rpc: { session: () => ({ providerId: 'claude-code-telemetry', input: total, output: total, read: total, written: total, costMin: total, costMax: total,
      keepaliveCostMin: total, keepaliveCostMax: total, unattributedReports: 0, totalTurns: 1, keepaliveTurns: 0, syncedThroughSeq: 10,
      turns: [saved], nextBeforeSeq: null }) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText(/· 2 requests · first: hit 40% · /)).toBeTruthy();
  expect(slot.getByText('Partly — 13,220 of 32,418 prompt tokens read from cache (40%)')).toBeTruthy();
  expect(slot.getByText(/^2 requests in this turn · first request:/)).toBeTruthy();
});

it('shows the duration an existing keepalive lease was set for instead of resetting to 6 hours', async () => {
  const { ThreadCacheDetails } = await import('./thread-cache');
  const threadId = 'thr_lease123';
  const now = Date.now();
  const watch = { threadId, armedAt: now - 3_600_000, until: now + 7 * 3_600_000, lastAttemptAt: null, sent: 1, error: null, disabled: false };
  const slot = renderSlot({ component: ThreadCacheDetails }, { threadId, projectId: 'proj_test', environment: null, segments: [], isExpanded: true, onToggle() {} }, {
    rpc: { status: () => ({ ...cacheStatus(threadId), watch, nextPingAt: null }), start: () => watch },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText(/· set for 8 h · 1 pings/)).toBeTruthy();
  const input = slot.getByRole('spinbutton', { name: 'Keepalive duration (hours)' }) as HTMLInputElement;
  expect(input.value).toBe('8');
  fireEvent.click(slot.getByRole('button', { name: 'Renew paid keepalive' }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter(c => c.method === 'start').map(c => c.input)).toEqual([{ threadId, durationHours: 8 }]));
});

it('does not add a marker to user messages or messages without a turn', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  for (const message of [
    { id: 'user1', role: 'user', initiator: 'user', threadId: 'thr_demo123', turnId: 'turn1', createdAt: 1000 },
    { id: 'assistant1', role: 'assistant', threadId: 'thr_demo123', turnId: null, createdAt: 1000 },
  ] as const) {
    const slot = renderSlot(app.messageMetadata[0]!, { message });
    unmounts.push(() => slot.lifecycle.unmount());
    expect(slot.queryByRole('button', { name: /Turn cache statistics/ })).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  }
});

it('shows persistent session totals with explicit missing costs and expandable older turns', async () => {
  const { SessionStatisticsPanel } = await import('./statistics-ui');
  const summary = { known: 10000, unknownTurns: 0 };
  const totals = { input: summary, output: { known: 1000, unknownTurns: 0 }, read: { known: 8000, unknownTurns: 0 }, written: { known: 0, unknownTurns: 1 },
    costMin: { known: 0.0148, unknownTurns: 1 }, costMax: { known: 0.0148, unknownTurns: 1 },
    keepaliveCostMin: { known: 0, unknownTurns: 0 }, keepaliveCostMax: { known: 0, unknownTurns: 0 }, unattributedReports: 0,
    totalTurns: 2, keepaliveTurns: 0, syncedThroughSeq: 10 };
  const slot = renderSlot({ component: SessionStatisticsPanel }, { threadId: 'thr_demo123' }, {
    rpc: { session: (input: unknown) => ({ ...totals, turns: [savedTurn((input as { beforeSeq?: number }).beforeSeq ? 'older' : 'latest')],
      nextBeforeSeq: (input as { beforeSeq?: number }).beforeSeq ? null : 2 }) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText(/2 turns · 0 keepalive turns/)).toBeTruthy();
  expect(slot.getByText('$0.0148 known; 1 turns unreported')).toBeTruthy();
  expect(slot.getByText('0 known; 1 turns unreported')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Load older turns' }));
  await waitFor(() => expect(slot.queryByRole('button', { name: 'Load older turns' })).toBeNull());
  expect(slot.inspection.rpcCalls[1]?.input).toEqual({ threadId: 'thr_demo123', beforeSeq: 2 });
});

for (const surface of ['card', 'banner'] as const) {
  it(`opens saved session statistics for the pane from its ${surface} without starting keepalive`, async () => {
    const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
    const threadId = 'thr_inpane123';
    const empty = { known: 0, unknownTurns: 0 };
    const props = { threadId, projectId: 'proj_test', environment: null,
      segments: [], isExpanded: true, onToggle() {} };
    const options = { context: { projectId: 'proj_other', threadId: 'thr_other123' }, rpc: {
      status: () => cacheStatus(threadId),
      session: () => ({ turns: [savedTurn()], totalTurns: 1, keepaliveTurns: 0,
        input: empty, output: empty, read: empty, written: empty, costMin: empty, costMax: empty,
        keepaliveCostMin: empty, keepaliveCostMax: empty, unattributedReports: 0, nextBeforeSeq: null, syncedThroughSeq: 10 }),
    } };
    const slot = surface === 'card' ? renderSlot(app.threadContextCardSections[0]!, props, options)
      : renderSlot({ component: app.threadContextSegments[0]!.details! }, props, options);
    unmounts.push(() => slot.lifecycle.unmount());
    expect(slot.inspection.rpcCalls.some(call => call.method === 'session')).toBe(false);
    fireEvent.click(await slot.findByRole('button', { name: 'Session statistics' }));
    const dialog = await slot.findByRole('dialog', { name: 'Session cache statistics' });
    expect(dialog.style.maxHeight).toBe('min(85dvh, 48rem)');
    expect(await slot.findByText(/1 turns · 0 keepalive turns/)).toBeTruthy();
    expect(slot.getByLabelText('Session statistics scroll area').className).toContain('overflow-y-auto');
    expect(slot.inspection.rpcCalls.filter(call => call.method === 'session').every(call => (call.input as { threadId: string }).threadId === threadId)).toBe(true);
    expect(slot.inspection.rpcCalls.some(call => call.method === 'start')).toBe(false);
    fireEvent.click(slot.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(slot.queryByRole('dialog')).toBeNull());
    slot.lifecycle.unmount();
  });
}

it('shows Anthropic pricing and Claude Code identity in saved turn details without Codex branding', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const saved = { ...savedTurn('claude-turn'), providerId: 'claude-code',
    turn: { ...savedTurn().turn, firstReadTokens: null, note: 'Claude Code reports aggregate usage per turn.' },
    cost: { ...savedTurn().cost, providerId: 'claude-code', model: 'claude-opus-5-5',
      pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', pricingLabel: 'Anthropic Standard API rates',
      note: 'Claude Code turn usage. Input excludes cache reads/writes.' },
  };
  const slot = renderSlot(app.messageMetadata[0]!, { message: { id: 'claude-reply', threadId: 'thr_claude123', turnId: 'claude-turn', role: 'assistant', createdAt: 1000 } }, {
    rpc: { turn: () => saved },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByRole('button', { name: /Turn cache statistics: Cache · first: unknown/ }));
  const dialog = await slot.findByRole('dialog');
  expect(slot.getByRole('link', { name: 'Anthropic Standard API rates' }).getAttribute('href')).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
  expect(dialog.textContent).toContain('Claude Code');
  expect(dialog.textContent).toContain('Input (uncached)');
  expect(dialog.textContent).not.toMatch(/OpenAI|Codex/);
});

it('labels aggregate remainders and incomplete telemetry in compact formulas without adding a request table', async () => {
  const { TurnUsageDetails } = await import('./thread-cache');
  const step = { seq: 1, at: 1000, inputTokens: 10, outputTokens: 10, readTokens: 1000, writeTokens: 0,
    source: 'request' as const, messageId: 'msg-first', model: 'claude-opus-5-5', combined: false, incomplete: false };
  const slot = renderSlot({ component: TurnUsageDetails }, { turn: {
    turnId: 'telemetry-turn', inputTokens: 30, outputTokens: 30, readTokens: 3000, writeTokens: 0, firstReadTokens: 1000, note: null,
    steps: [step, { ...step, seq: 2, messageId: 'msg-interrupted', combined: true, incomplete: true },
      { ...step, seq: 3, source: 'aggregate-remainder', messageId: null, model: null, combined: true, incomplete: true }],
  } });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(slot.getByText('Read (≈): 1k + 1k*† + 1k* = 3k').title).toContain('aggregate-remainder');
  expect(slot.getByText('Written (≈): 0k + 0k*† = 0k').title).toContain('msg-interrupted');
  expect(slot.queryByRole('table')).toBeNull();
});

it('omits only exactly zero aggregate terms and keeps small positive and unknown remainders', async () => {
  const { TurnUsageDetails } = await import('./thread-cache');
  const request = { seq: 1, at: 1000, inputTokens: 10, outputTokens: 10, readTokens: 1000, writeTokens: 0,
    source: 'request' as const, messageId: 'first', model: 'claude-opus-5-5', combined: false, incomplete: false };
  for (const read of [0, 200, null]) {
    const slot = renderSlot({ component: TurnUsageDetails }, { turn: {
      turnId: 't1', inputTokens: 20, outputTokens: 20, readTokens: read === null ? null : 1000 + read,
      writeTokens: 0, firstReadTokens: 1000, note: null,
      steps: [request, { ...request, seq: 2, source: 'aggregate-remainder', messageId: null, model: null,
        readTokens: read, combined: true, incomplete: true }],
    } });
    unmounts.push(() => slot.lifecycle.unmount());
    expect(slot.getByText(read === 0 ? 'Read (≈): 1k = 1k' : read === null ? 'Read (≈): 1k + ?* = ?' : 'Read (≈): 1k + 0k* = 1k')).toBeTruthy();
    expect(slot.getByText('Written (≈): 0k = 0k')).toBeTruthy();
    expect(slot.queryByText(/†/)).toBeNull();
    slot.lifecycle.unmount();
  }
});

it('styles the cache disclosure like Git with a chevron and collapses through the same row', async () => {
  const { useState } = await import('react');
  const { ThreadCacheSummary, ThreadCacheDetails } = await import('./thread-cache');
  function Disclosure({ threadId }: { threadId: string }) {
    const [isExpanded, setExpanded] = useState(false);
    const props = { threadId, projectId: 'proj_test', environment: null, segments: [], isExpanded,
      onToggle: () => setExpanded(open => !open) };
    return <><ThreadCacheSummary {...props} /><ThreadCacheDetails {...props} /></>;
  }
  const slot = renderSlot({ component: Disclosure }, { threadId: 'thr_disclosure123' }, {
    rpc: { status: () => cacheStatus('thr_disclosure123') },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const trigger = await slot.findByRole('button', { name: /Cache:.*read.*written/ });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.className).toContain('hover:bg-state-hover');
  expect(trigger.querySelector('[data-icon="ChevronDown"]')).toBeTruthy();
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(trigger.className.split(' ')).not.toContain('bg-state-hover');
  expect(trigger.querySelector('[data-icon="ChevronUp"]')).toBeTruthy();
  expect(slot.getByRole('region', { name: 'Cache details' })).toBeTruthy();
  expect(slot.queryByRole('button', { name: 'Close cache details' })).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(slot.queryByRole('region', { name: 'Cache details' })).toBeNull();
});

it('rounds the midpoint in a Claude turn marker and retains the full range in details', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const saved = savedTurn('claude-turn');
  const slot = renderSlot(app.messageMetadata[0]!, {
    message: { id: 'reply', threadId: 'thr_claude123', turnId: 'claude-turn', role: 'assistant', createdAt: 1000 },
  }, { rpc: { turn: () => ({ ...saved, cost: { ...saved.cost, minUsd: 0.1608, maxUsd: 0.1637 } }) } });
  unmounts.push(() => slot.lifecycle.unmount());
  const button = await slot.findByRole('button', { name: /Turn cache statistics:.*~\$0.16$/ });
  expect(button.textContent).not.toContain('0.1608');
  fireEvent.click(button);
  expect(await slot.findByText('$0.1608–$0.1637')).toBeTruthy();
});

it('moves cache from context to a header action and opens details for the selected pane', async () => {
  const { registerCacheHeader } = await import('./header-cache');
  let registration: any;
  const app = await loadPluginApp(definePluginApp(builder => {
    registerCacheHeader({ ...builder, slots: { ...builder.slots,
      experimental_threadAction(value) { registration = value; builder.slots.experimental_threadAction(value); },
    } });
  }));
  expect(registration.placement).toBe('header');
  const overlay = renderSlot(app.appOverlays[0]!, {} , { rpc: { status: () => cacheStatus('thr_pane123') } });
  unmounts.push(() => overlay.lifecycle.unmount());
  function Header() {
    const data = registration.useData({ threadIds: ['thr_pane123'] });
    const item = registration.item({ thread: { id: 'thr_pane123' }, data });
    return item ? <button onClick={() => item.run({})}>{item.label}</button> : null;
  }
  const header = renderSlot({ component: Header }, {}, {
    settings: { cachePlacement: 'header' }, rpc: { status: () => cacheStatus('thr_pane123') },
  });
  unmounts.push(() => header.lifecycle.unmount());
  fireEvent.click(await header.findByRole('button', { name: 'Cache · TTL not reported' }));
  expect(await overlay.findByRole('dialog', { name: 'Prompt cache' })).toBeTruthy();
  expect(await overlay.findByText((14590).toLocaleString())).toBeTruthy();
  expect(overlay.inspection.rpcCalls.every(call => (call.input as { threadId: string }).threadId === 'thr_pane123')).toBe(true);
  overlay.lifecycle.unmount();
  header.lifecycle.unmount();
  const fullApp = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const card = renderSlot(fullApp.threadContextCardSections[0]!, {
    threadId: 'thr_pane123', projectId: 'proj_test', environment: null,
  }, { settings: { cachePlacement: 'header' } });
  unmounts.push(() => card.lifecycle.unmount());
  expect(card.queryByLabelText('Thread cache usage')).toBeNull();
  expect(card.inspection.rpcCalls).toHaveLength(0);
});

it('styles host cache labels by TTL, updates through expiry, and cleans up on reload', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const fixture = document.createElement('div');
  fixture.innerHTML = '<div data-thread-header-workflow-actions><button>Cache · ~1m 11s left</button><button>Commit</button></div><div role="menuitem">Cache · ~2m 08s left · assumed 30m</div><button>Cache · ~1m 11s left</button>';
  document.body.append(fixture);
  const scripts = await mountPluginContentScripts(app, { pluginId: 'cache-watch', generation: 1 });
  try {
    const header = fixture.querySelector('button')!;
    const marker = 'data-cache-watch-header-font';
    expect(header.hasAttribute(marker)).toBe(true);
    expect(getComputedStyle(header).fontFamily).toContain('monospace');
    expect(header.getAttribute(marker)).toBe('active');
    expect(getComputedStyle(header).color).toBe('rgb(21, 128, 61)');
    expect(fixture.querySelector('[role="menuitem"]')!.hasAttribute(marker)).toBe(true);
    expect(fixture.querySelectorAll(`[${marker}]`)).toHaveLength(2);
    header.textContent = 'Cache · ~1m 10s left';
    await waitFor(() => expect(header.hasAttribute(marker)).toBe(true));
    header.textContent = 'Cache · Estimated TTL elapsed · assumed 30m';
    await waitFor(() => expect(header.getAttribute(marker)).toBe('elapsed'));
    expect(getComputedStyle(header).color).toBe('rgb(185, 28, 28)');
    document.documentElement.classList.add('dark');
    try {
      expect(getComputedStyle(header).color).toBe('rgb(248, 113, 113)');
    } finally { document.documentElement.classList.remove('dark'); }
    header.textContent = 'Cache · TTL not reported';
    await waitFor(() => expect(header.getAttribute(marker)).toBe('unknown'));
    header.textContent = 'Cache · unavailable';
    await waitFor(() => expect(header.getAttribute(marker)).toBe('unknown'));
    header.textContent = 'Cache · ~0m 01s left · stale';
    await waitFor(() => expect(header.getAttribute(marker)).toBe('active'));
    expect(fixture.querySelector('[role="menuitem"]')!.getAttribute(marker)).toBe('active');
    header.textContent = 'Commit';
    await waitFor(() => expect(header.hasAttribute(marker)).toBe(false));
    const newHeader = document.createElement('button');
    newHeader.textContent = 'Cache · ~0m 09s left';
    fixture.firstElementChild!.append(newHeader);
    await waitFor(() => expect(newHeader.hasAttribute(marker)).toBe(true));
    await scripts.lifecycle.dispose();
    expect(fixture.querySelectorAll(`[${marker}]`)).toHaveLength(0);
  } finally {
    await scripts.lifecycle.dispose();
    fixture.remove();
  }
});

it('shows unknown and elapsed TTL, disables filtering at zero, and includes the exact threshold', () => {
  const now = 1793390345316;
  expect(cacheIsVisible(now + 61_000, now, 60)).toBe(false);
  expect(cacheIsVisible(now + 60_000, now, 60)).toBe(true);
  expect(cacheIsVisible(now + 61_000, now, 0)).toBe(true);
  expect(cacheIsVisible(null, now, 60)).toBe(true);
  expect(cacheIsVisible(NaN, now, 60)).toBe(true);
  expect(cacheIsVisible(now - 1, now, 60)).toBe(true);
});

for (const surface of ['header', 'banner', 'card'] as const) {
  it(`reveals the ${surface} at the TTL threshold without waiting for a server poll`, async () => {
    vi.useFakeTimers();
    const now = 1793390345316;
    vi.setSystemTime(now);
    const threadId = 'thr_threshold123';
    let expiresAt = now + 61_000;
    let registration: any;
    const app = await loadPluginApp(definePluginApp(builder => appDefinition.setup({
      ...builder, slots: { ...builder.slots, experimental_threadAction(value) {
        if (value.id === 'cache-header') registration = value;
        builder.slots.experimental_threadAction(value);
      } },
    })));
    function Header() {
      const data = registration.useData({ threadIds: [threadId] });
      const item = registration.item({ thread: { id: threadId }, data });
      return item ? <button>{item.label}</button> : null;
    }
    const props = { threadId, projectId: 'proj_test', environment: null, segments: [], isExpanded: false, onToggle() {} };
    let requests = 0;
    let slot!: ReturnType<typeof renderSlot>;
    await act(async () => {
      const Card = app.threadContextCardSections[0]!.component;
      const Summary = app.threadContextSegments[0]!.action!;
      function Surface() { return surface === 'header' ? <Header /> : surface === 'card' ? <Card {...props} /> : <Summary {...props} />; }
      slot = renderSlot({ component: Surface }, {}, {
        settings: { cachePlacement: surface === 'header' ? 'header' : 'context', cacheShowBelowSeconds: 60 },
        rpc: { status: () => { requests++; return { ...cacheStatus(threadId), estimatedExpiresAt: expiresAt }; } },
      });
    });
    unmounts.push(() => slot.lifecycle.unmount());
    const visible = () => surface === 'card' ? slot.queryByLabelText('Thread cache usage') : slot.queryByRole('button', { name: /Cache/ });
    expect(visible()).toBeNull();
    const initialRequests = requests;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(visible()).toBeTruthy();
    expect(requests).toBe(initialRequests);
    expiresAt = now + 300_000;
    await act(async () => { await slot.behavior.emitRealtime('changed', null); });
    expect(visible()).toBeNull();
  });
}

it('keeps a preset chosen immediately after a save instead of reverting to the saved template', async () => {
  const { DEFAULT_STATUS_TEMPLATE, STATUS_PRESETS } = await import('./status-template');
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  let stored: string = DEFAULT_STATUS_TEMPLATE;
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    rpc: { getStatusTemplate: () => ({ template: stored }),
      setStatusTemplate: (input: unknown) => { stored = (input as { template: string }).template; return { template: stored }; } },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const group = slot.getByRole('group', { name: 'Thread header' });
  const header = within(group);
  const editor = await header.findByRole('textbox', { name: 'Status template' }) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.hasAttribute('disabled')).toBe(false));
  const preset = header.getByRole('combobox', { name: 'Status template preset' });
  fireEvent.change(preset, { target: { value: 'Detailed' } });
  // Choose the next preset in the same task as the commit that reports the save,
  // before React runs that commit's effects.
  const chosen = new Promise<void>(resolve => {
    const observer = new MutationObserver(() => {
      if (!group.textContent!.includes('Template saved.')) return;
      observer.disconnect();
      fireEvent.change(preset, { target: { value: 'Default' } });
      resolve();
    });
    observer.observe(group, { childList: true, subtree: true });
  });
  fireEvent.click(header.getByRole('button', { name: 'Save template' }));
  await chosen;
  await act(async () => {});
  expect(stored).toBe(STATUS_PRESETS.find(item => item.name === 'Detailed')!.template);
  expect(editor.value).toBe(DEFAULT_STATUS_TEMPLATE);
});

it('edits, previews, validates, saves presets and restores the default template in settings', async () => {
  const { DEFAULT_STATUS_TEMPLATE, STATUS_PRESETS, VARIABLES } = await import('./status-template');
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  let stored: string = DEFAULT_STATUS_TEMPLATE;
  const saves: string[] = [];
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    rpc: {
      getStatusTemplate: () => ({ template: stored }),
      setStatusTemplate: (input: unknown) => {
        stored = (input as { template: string }).template;
        saves.push(stored); return { template: stored };
      },
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const header = within(slot.getByRole('group', { name: 'Thread header' }));
  expect(slot.queryByRole('button', { name: 'Default' })).toBeNull();
  const editor = await header.findByRole('textbox', { name: 'Status template' });
  await waitFor(() => expect(editor.hasAttribute('disabled')).toBe(false));
  fireEvent.change(header.getByRole('combobox', { name: 'Status template preset' }), { target: { value: 'Clock' } });
  expect(header.getByLabelText('Status preview').textContent).toBe('Cache · warm · 00:04:09');
  fireEvent.change(header.getByRole('combobox', { name: 'Preview cache state' }), { target: { value: 'unknown' } });
  expect(header.getByLabelText('Status preview').textContent).toBe('Cache · unknown');
  fireEvent.change(editor, { target: { value: '{{#if firstHit == null}}?{{else}}{{#if firstHit}}✓{{else}}✗{{/if}}{{/if}} {{cost | usd:2}}' } });
  expect(header.getByLabelText('Status preview').textContent).toBe('? $0.16');
  fireEvent.change(editor, { target: { value: '{{badVariable}}' } });
  expect(header.getByRole('alert').textContent).toContain('Unknown variable');
  expect(header.getByRole('button', { name: 'Save template' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(header.getByRole('combobox', { name: 'Status template preset' }), { target: { value: 'Detailed' } });
  fireEvent.click(header.getByRole('button', { name: 'Save template' }));
  expect(await slot.findByText('Template saved.')).toBeTruthy();
  expect(saves[0]).toBe(STATUS_PRESETS.find(preset => preset.name === 'Detailed')!.template);
  fireEvent.change(header.getByRole('combobox', { name: 'Status template preset' }), { target: { value: 'Default' } });
  expect((editor as HTMLTextAreaElement).value).toBe(DEFAULT_STATUS_TEMPLATE);
  fireEvent.click(header.getByRole('button', { name: 'Save template' }));
  await waitFor(() => expect(saves[1]).toBe(DEFAULT_STATUS_TEMPLATE));
  for (const name of Object.keys(VARIABLES)) {
    const term = slot.getByText(name, { selector: 'dt' });
    expect(term.parentElement!.className).toBe('contents');
    expect(term.nextElementSibling!.textContent).toBe('-');
    expect(term.parentElement!.parentElement!.className).toContain('grid-cols-[max-content_auto_minmax(0,1fr)]');
  }
});

it('keeps custom header text colored and monospaced independently of its wording', async () => {
  const { registerCacheHeader } = await import('./header-cache');
  let registration: any;
  const app = await loadPluginApp(definePluginApp(builder => {
    registerCacheHeader({ ...builder, slots: { ...builder.slots, experimental_threadAction(value) {
      registration = value; builder.slots.experimental_threadAction(value);
    } } });
  }));
  function Header() {
    const data = registration.useData({ threadIds: ['thr_custom123'] });
    const item = registration.item({ thread: { id: 'thr_custom123' }, data });
    return <div data-thread-header-workflow-actions>{item && <button>{item.label}</button>}</div>;
  }
  let report = { ...cacheStatus('thr_custom123'), estimatedExpiresAt: Date.now() + 600_000 };
  const slot = renderSlot({ component: Header }, {}, {
    settings: { cachePlacement: 'header' },
    rpc: { getStatusTemplate: () => ({ template: 'Мой кеш: {{state}} · {{seconds | pad2}}' }), status: () => report },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const scripts = await mountPluginContentScripts(app, { pluginId: 'cache-watch', generation: 1 });
  try {
    const button = await slot.findByRole('button', { name: /Мой кеш: warm/ });
    await waitFor(() => expect(button.getAttribute('data-cache-watch-header-font')).toBe('active'));
    expect(getComputedStyle(button).fontFamily).toContain('monospace');
    report = { ...report, estimatedExpiresAt: Date.now() - 1000 };
    await slot.behavior.emitRealtime('changed', null);
    await waitFor(() => expect(button.getAttribute('data-cache-watch-header-font')).toBe('elapsed'));
    expect(button.textContent).toContain('expired');
  } finally { await scripts.lifecycle.dispose(); }
});

it('uses the context template with live TTL values and updates it after saving settings', async () => {
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const threadId = 'thr_contexttemplate123';
  let template = 'Context {{firstRequest}} · {{#mono}}{{minutes | pad2}}:{{seconds | pad2}}{{/mono}}';
  const slot = renderSlot({ component: app.threadContextSegments[0]!.action! }, {
    threadId, projectId: 'proj_test', environment: null, segments: [], isExpanded: false, onToggle() {},
  }, {
    rpc: {
      status: () => ({ ...cacheStatus(threadId), estimatedExpiresAt: Date.now() + 61_000 }),
      getStatusTemplate: (input: unknown) => {
        expect(input).toEqual({ surface: 'context' });
        return { template };
      },
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const button = await slot.findByRole('button', { name: /Context hit · 01:01/ });
  expect(button.textContent).not.toContain('Cache:');
  expect(slot.getByText(/Context hit/).className).not.toContain('font-mono');
  expect(slot.getByText('01:01').className).toContain('font-mono');
  template = 'State: {{state}}';
  await slot.behavior.emitRealtime('template-changed', null);
  expect(await slot.findByRole('button', { name: 'State: warm' })).toBeTruthy();
});

it('edits context and header templates separately and picks a distinct context default', async () => {
  const { DEFAULT_STATUS_TEMPLATE, DEFAULT_CONTEXT_TEMPLATE } = await import('./status-template');
  const app = await loadPluginApp(() => Promise.resolve({ default: appDefinition }));
  const stored = { header: DEFAULT_STATUS_TEMPLATE, context: 'Saved context: {{ttl}}' };
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    rpc: {
      getStatusTemplate: (input: unknown) => ({ template: stored[(input as { surface: 'header' | 'context' } | null)?.surface ?? 'header'] }),
      setStatusTemplate: (input: unknown) => {
        const { surface, template } = input as { surface: 'header' | 'context'; template: string };
        stored[surface] = template; return { template };
      },
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  const context = within(slot.getByRole('group', { name: 'Thread context' }));
  const header = within(slot.getByRole('group', { name: 'Thread header' }));
  const contextInput = context.getByRole('textbox', { name: 'Status template' }) as HTMLTextAreaElement;
  await waitFor(() => expect(contextInput.value).toBe(stored.context));
  fireEvent.change(context.getByRole('combobox', { name: 'Status template preset' }), { target: { value: 'Default' } });
  expect(contextInput.value).toBe(DEFAULT_CONTEXT_TEMPLATE);
  expect(context.getByLabelText('Status preview').textContent).toContain('734.8K read');
  fireEvent.click(context.getByRole('button', { name: 'Save template' }));
  await waitFor(() => expect(stored.context).toBe(DEFAULT_CONTEXT_TEMPLATE));
  expect(stored.header).toBe(DEFAULT_STATUS_TEMPLATE);
  expect((header.getByRole('textbox', { name: 'Status template' }) as HTMLTextAreaElement).value).toBe(DEFAULT_STATUS_TEMPLATE);
});

it('shows the cache-write lifetime split only when telemetry reports it', async () => {
  const { TurnUsageDetails } = await import('./thread-cache');
  const step = { seq: 1, at: 1000, inputTokens: 10, outputTokens: 10, readTokens: 1000, writeTokens: 12000,
    source: 'request' as const, messageId: 'msg', model: 'claude-opus-5-5', combined: false, incomplete: false };
  const turn = { turnId: 't1', inputTokens: 10, outputTokens: 10, readTokens: 1000, writeTokens: 12000, firstReadTokens: 1000, note: null, steps: [step] };
  const split = renderSlot({ component: TurnUsageDetails }, { turn: { ...turn, writeLifetimes: { fiveMinuteTokens: 2000, oneHourTokens: 9600, unknownTokens: 400 } } });
  expect(split.getByText('Written by lifetime (≈): 5m 2k · 1h 10k · unknown 0k')).toBeTruthy();
  split.lifecycle.unmount();
  const plain = renderSlot({ component: TurnUsageDetails }, { turn });
  unmounts.push(() => plain.lifecycle.unmount());
  expect(plain.queryByText(/Written by lifetime/)).toBeNull();
});

it('shows session write lifetimes with their turn coverage', async () => {
  const { SessionStatisticsPanel } = await import('./statistics-ui');
  const n = (known: number) => ({ known, unknownTurns: 0 });
  const slot = renderSlot({ component: SessionStatisticsPanel }, { threadId: 'thr_demo123' }, {
    rpc: { session: () => ({ input: n(1), output: n(1), read: n(1), written: n(300), costMin: n(0), costMax: n(0),
      keepaliveCostMin: n(0), keepaliveCostMax: n(0), unattributedReports: 0, totalTurns: 2, keepaliveTurns: 0, syncedThroughSeq: 10,
      writeLifetimeTurns: 1, written5m: n(100), written1h: n(0), writtenUnknownLifetime: n(0), turns: [], nextBeforeSeq: null }) },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText('Cache written, 5m lifetime')).toBeTruthy();
  expect(slot.getByText('1 of 2 turns; other turns report no lifetimes')).toBeTruthy();
});

it('recommends the Claude Code Telemetry provider only for built-in Claude Code', async () => {
  const { TelemetryProviderHint, TELEMETRY_PROVIDER_URL } = await import('./thread-cache');
  const builtIn = renderSlot({ component: TelemetryProviderHint }, { providerId: 'claude-code' });
  expect(builtIn.getByRole('link', { name: 'Claude Code Telemetry provider' }).getAttribute('href')).toBe(TELEMETRY_PROVIDER_URL);
  builtIn.lifecycle.unmount();
  for (const providerId of ['claude-code-telemetry', 'codex']) {
    const other = renderSlot({ component: TelemetryProviderHint }, { providerId });
    expect(other.queryByRole('link')).toBeNull();
    other.lifecycle.unmount();
  }
});
