// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import appDefinition from './app';
import { definePluginApp, type PluginCommandRegistration } from '@get-bb/plugin-sdk/app';
import { experimental_makePanelController } from '@get-bb/plugin-sdk/testing';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { remainingTime } from './thread-cache';

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
