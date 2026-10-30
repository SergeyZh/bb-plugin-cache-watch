// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import appDefinition from './app';
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
      start: (input: unknown) => { starts.push(input); return { threadId: 'thr_demo123', intervalMinutes: 4, armedAt: Date.now(), until: Date.now() + 21_600_000, lastAttemptAt: null, sent: 0, error: null, disabled: false }; },
    },
  });
  unmounts.push(() => slot.lifecycle.unmount());
  expect(await slot.findByText('Demo thread')).toBeTruthy();
  expect(await slot.findByText('Keepalive uses ordinary paid turns')).toBeTruthy();
  expect(starts).toEqual([]);
  fireEvent.click(await slot.findByRole('button', { name: 'Enable paid keepalive' }));
  await waitFor(() => expect(starts).toEqual([{ threadId: 'thr_demo123', intervalMinutes: 4, durationHours: 6 }]));
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
