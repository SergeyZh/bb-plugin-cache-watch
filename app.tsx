import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_useThreadContextKind, useBbContext, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { CacheMessageMetadata, SessionStatisticsPanel, SessionStatisticsButton } from './statistics-ui';
import { StatusTemplateSettings } from './template-settings';
import { registerCacheHeader } from './header-cache';
import { registerKeepaliveCommands } from './keepalive-commands';
import { CostDetails, LastCacheUse, TelemetryProviderHint, TurnUsageDetails, ThreadCacheCard, ThreadCacheDetails, ThreadCacheSummary, useCachePlacement } from './thread-cache';
import type { rpcContract, CacheStatus } from './server';
import type { Watch } from './core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function time(value: number | null) { return value === null ? 'Unknown' : new Date(value).toLocaleString(); }
function CacheWatchPage() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const [threadId, setThreadId] = useState(context.threadId ?? '');
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
  // Nothing to stop while keepalive is known to be off. Keep the control when
  // the state could not be read, so paid pings can always be stopped.
  const known = status?.threadId === threadId;
  const watch = known ? status.watch : null;
  const active = !!watch && !watch.disabled && watch.until > Date.now();
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await refresh(); } catch (e) { report(e); } finally { setBusy(false); }
  }
  return <div className="h-full min-h-0 overflow-y-auto overscroll-contain" aria-label="Cache Watch page scroll area"><div className="mx-auto max-w-3xl space-y-6 p-6 text-sm">
    <header className="space-y-2"><h1 className="text-xl font-semibold">Cache Watch</h1>
      <p className="text-muted-foreground">Inspect the last reported cache usage and keep an idle thread active for a limited time.</p></header>
    {!threadId && <p className="text-muted-foreground">To view session statistics, open Cache inside that session and choose Session statistics. You can also enter a Thread ID below.</p>}
    <div className="rounded-lg border p-4 space-y-2">
      <p className="font-medium">Keepalive uses ordinary paid turns</p>
      <p className="text-muted-foreground">Each ping and its reply remain in the transcript. The agent is instructed to reply OK without tools. BB does not enforce a tool ban for these turns. Cache reuse and savings are not guaranteed.</p>
      <p className="text-muted-foreground">Pings are scheduled 5 minutes before estimated expiry, using provider TTL when reported. Without a reported TTL, the provider-specific fallback is shown in the session cache panel. Unknown or elapsed expiry waits for fresh telemetry.</p>
    </div>
    <section className="space-y-3">
      <label className="block space-y-1">Thread ID<Input value={threadId} onChange={e => { setThreadId(e.target.value.trim()); setStatus(null); }} placeholder="thr_…" /></label>
      <div className="flex gap-4">
        <label className="flex-1 space-y-1">Keep alive for (hours)<Input type="number" min="1" max="24" step="1" value={hours} onChange={e => setHours(e.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !threadId} variant="outline" onClick={() => void act(refresh)}>Refresh status</Button>
        <Button disabled={busy || !threadId} onClick={() => void act(() => rpc.call('start', { threadId, durationHours: Number(hours) }))}>{active ? 'Renew paid keepalive' : 'Enable paid keepalive'}</Button>
        {!!threadId && (!known || watch) && <Button disabled={busy} variant="outline" onClick={() => void act(() => rpc.call('stop', { threadId }))}>{!watch || active ? 'Stop keepalive' : 'Clear keepalive'}</Button>}
      </div>
    </section>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {status && <section className="rounded-lg border p-4 space-y-2">
      <h2 className="font-semibold">{status.title}</h2>
      <p className="text-muted-foreground">{status.providerId} · {status.status}</p>
      <dl className="grid grid-cols-2 gap-2">
        <dt>Last usage report</dt><dd>{time(status.sample?.at ?? null)}</dd>
        <dt>Cache used (first request)</dt><dd><LastCacheUse turn={status.turn} /></dd>
        <dt>Turn cached tokens read</dt><dd>{status.turn?.readTokens?.toLocaleString() ?? 'Not reported'}</dd>
        <dt>Turn cache tokens written</dt><dd>{status.turn?.writeTokens?.toLocaleString() ?? 'Not reported'}</dd>
        <dt>Estimated cache expiry{status.expirySource === 'codex-assumption' ? ' (assumed 30m)' : ''}</dt><dd className={status.estimatedExpiresAt === null ? '' : status.estimatedExpiresAt > Date.now() ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>{time(status.estimatedExpiresAt)}</dd>
        <dt>Next ping due</dt><dd>{time(status.nextPingAt)}</dd>
        <dt>Keepalive ends</dt><dd>{time(status.watch?.until ?? null)}</dd>
        <dt>Pings sent</dt><dd>{status.watch?.sent ?? 0}</dd>
      </dl>
      <p className="text-muted-foreground">Read/write counts are summed over the latest turn. Cache use refers to its first request; the breakdown shows cache use per request. Provider reports may combine requests. They do not measure the size of a live cache. The expiry estimate is based on provider telemetry; the cache's current state cannot be checked here. Due pings run on a one-minute sweep and wait while the thread is busy.</p>
      <TurnUsageDetails turn={status.turn} />
      <TelemetryProviderHint providerId={status.providerId} />
      <CostDetails cost={status.cost} />
      {status.watch?.error && <p role="alert" className="text-destructive">{status.watch.error}</p>}
    </section>}
    {/^thr_[a-z0-9]+$/.test(threadId) && <SessionStatisticsPanel key={threadId} threadId={threadId} />}
    <section className="space-y-2"><h2 className="font-semibold">Configured watches</h2>
      {watches.length === 0 ? <p className="text-muted-foreground">No keepalives enabled.</p> : watches.map(w => <div key={w.threadId} className="flex items-center gap-3 rounded-lg border p-3">
        <button className="flex-1 text-left underline" onClick={() => setThreadId(w.threadId)}>{w.threadId}</button>
        <span>{w.disabled ? 'Paused' : w.until <= Date.now() ? 'Expired' : 'Enabled'} · {w.sent} pings</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call('stop', { threadId: w.threadId }))}>Stop</Button>
      </div>)}
    </section>
  </div></div>;
}
export default definePluginApp(app => {
  registerKeepaliveCommands(app);
  registerCacheHeader(app);
  app.slots.settingsSection({ id: 'status-template', title: 'Status templates', component: StatusTemplateSettings });
  app.slots.experimental_messageMetadata({ id: 'turn-cache-statistics', placement: 'actionRow', component: CacheMessageMetadata });
  app.slots.navPanel({ id: 'cache-watch', title: 'Cache Watch', icon: 'Flame', path: 'cache-watch', component: CacheWatchPage });
  app.slots.experimental_threadContextCardSection({
    id: 'cache-usage', title: 'Prompt cache', group: '0_cache', component: props => {
      const placement = useCachePlacement();
      return placement === 'context' ? <ThreadCacheCard {...props} hideWhenEarly sessionAction={<SessionStatisticsButton key={props.threadId} threadId={props.threadId} />} /> : null;
    },
  });
  app.slots.experimental_threadContextSegment({
    id: 'cache-usage', title: 'Prompt cache', group: '4_cache',
    summary: () => null, action: ThreadCacheSummary, details: props => <ThreadCacheDetails {...props} sessionAction={<SessionStatisticsButton key={props.threadId} threadId={props.threadId} />} />,
    useVisible: () => {
      const kind = experimental_useThreadContextKind();
      const placement = useCachePlacement();
      return kind === 'banner' && placement === 'context';
    },
  });
});
