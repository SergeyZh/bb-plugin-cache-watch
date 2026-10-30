import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_useThreadContextKind, useBbContext, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { ThreadCacheCard, ThreadCacheDetails, ThreadCacheSummary } from './thread-cache';
import type { rpcContract, CacheStatus } from './server';
import type { Watch } from './core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function time(value: number | null) { return value === null ? 'Unknown' : new Date(value).toLocaleString(); }
function CacheWatchPage() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const [threadId, setThreadId] = useState(context.threadId ?? '');
  const [minutes, setMinutes] = useState('4');
  const [hours, setHours] = useState('6');
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentId = useRef(threadId);
  currentId.current = threadId;
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const refresh = useCallback(async () => {
    const [all, current] = await Promise.all([rpc.call('list'), /^thr_[a-z0-9]+$/.test(threadId) ? rpc.call('status', { threadId }) : Promise.resolve(null)]);
    if (currentId.current !== threadId) return;
    setWatches(all); setStatus(current); setError('');
  }, [rpc, threadId]);
  useEffect(() => {
    let live = true;
    const update = () => { if (live) void refresh().catch(report); };
    update();
    const timer = setInterval(update, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [refresh, report]);
  useRealtime('changed', () => { void refresh().catch(report); });
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await refresh(); } catch (e) { report(e); } finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-6 p-6 text-sm">
    <header className="space-y-2"><h1 className="text-xl font-semibold">Cache Watch</h1>
      <p className="text-muted-foreground">Inspect the last reported cache usage and keep an idle thread active for a limited time.</p></header>
    <div className="rounded-lg border p-4 space-y-2">
      <p className="font-medium">Keepalive uses ordinary paid turns</p>
      <p className="text-muted-foreground">Each ping and its reply remain in the transcript. The agent is instructed to reply OK without tools. BB does not enforce a tool ban for these turns. Cache reuse and savings are not guaranteed.</p>
      <p className="text-muted-foreground">Choose an interval shorter than your provider's TTL: 4 minutes for a 5-minute cache, 25 for 30 minutes, or 55 for one hour. Polling the monitor does not warm the cache.</p>
    </div>
    <section className="space-y-3">
      <label className="block space-y-1">Thread ID<Input value={threadId} onChange={e => { setThreadId(e.target.value.trim()); setStatus(null); }} placeholder="thr_…" /></label>
      <div className="flex gap-4">
        <label className="flex-1 space-y-1">Ping interval (minutes)<Input type="number" min="2" max="55" value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
        <label className="flex-1 space-y-1">Keep alive for (hours)<Input type="number" min="0.25" max="24" step="0.25" value={hours} onChange={e => setHours(e.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !threadId} variant="outline" onClick={() => void act(refresh)}>Refresh status</Button>
        <Button disabled={busy || !threadId} onClick={() => void act(() => rpc.call('start', { threadId, intervalMinutes: Number(minutes), durationHours: Number(hours) }))}>Enable paid keepalive</Button>
        <Button disabled={busy || !threadId} variant="outline" onClick={() => void act(() => rpc.call('stop', { threadId }))}>Stop keepalive</Button>
      </div>
    </section>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {status && <section className="rounded-lg border p-4 space-y-2">
      <h2 className="font-semibold">{status.title}</h2>
      <p className="text-muted-foreground">{status.providerId} · {status.status}</p>
      <dl className="grid grid-cols-2 gap-2">
        <dt>Last usage report</dt><dd>{time(status.sample?.at ?? null)}</dd>
        <dt>Cached tokens read</dt><dd>{status.sample?.readTokens.toLocaleString() ?? 'Not reported'}</dd>
        <dt>Cache tokens written</dt><dd>{status.sample?.writeTokens?.toLocaleString() ?? 'Not reported'}</dd>
        <dt>Estimated cache expiry{status.expirySource === 'codex-assumption' ? ' (assumed 30m)' : ''}</dt><dd className={status.estimatedExpiresAt === null ? '' : status.estimatedExpiresAt > Date.now() ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>{time(status.estimatedExpiresAt)}</dd>
        <dt>Next ping due</dt><dd>{time(status.nextPingAt)}</dd>
        <dt>Keepalive ends</dt><dd>{time(status.watch?.until ?? null)}</dd>
        <dt>Pings sent</dt><dd>{status.watch?.sent ?? 0}</dd>
      </dl>
      <p className="text-muted-foreground">These are the latest provider-reported usage counts, which may combine several model requests in one turn. They do not measure the size of a live cache. The expiry estimate is based on provider telemetry; the cache's current state cannot be checked here. Due pings run on a one-minute sweep and wait while the thread is busy.</p>
      {status.watch?.error && <p role="alert" className="text-destructive">{status.watch.error}</p>}
    </section>}
    <section className="space-y-2"><h2 className="font-semibold">Configured watches</h2>
      {watches.length === 0 ? <p className="text-muted-foreground">No keepalives enabled.</p> : watches.map(w => <div key={w.threadId} className="flex items-center gap-3 rounded-lg border p-3">
        <button className="flex-1 text-left underline" onClick={() => setThreadId(w.threadId)}>{w.threadId}</button>
        <span>{w.disabled ? 'Paused' : w.until <= Date.now() ? 'Expired' : 'Enabled'} · {w.sent} pings</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call('stop', { threadId: w.threadId }))}>Stop</Button>
      </div>)}
    </section>
  </div>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'cache-watch', title: 'Cache Watch', icon: 'Flame', path: 'cache-watch', component: CacheWatchPage });
  app.slots.experimental_threadContextCardSection({
    id: 'cache-usage', title: 'Prompt cache', group: '0_cache', component: ThreadCacheCard,
  });
  app.slots.experimental_threadContextSegment({
    id: 'cache-usage', title: 'Prompt cache', group: '4_cache',
    summary: () => null, action: ThreadCacheSummary, details: ThreadCacheDetails,
    useVisible: () => experimental_useThreadContextKind() === 'banner',
  });
});
