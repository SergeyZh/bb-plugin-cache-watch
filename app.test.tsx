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
      return { ...cacheStatus(threadId, 0), sample: { ...cacheStatus(threadId).sample, readTokens: 0, writeTokens: null } };
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
