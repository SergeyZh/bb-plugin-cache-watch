import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  experimental_Icon as Icon,
  experimental_ThreadContextCardRow as ContextRow,
  useRealtime, useRpc,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentProps,
} from '@get-bb/plugin-sdk/app';
import type { TurnUsage } from './turn-usage';
import type { CacheStatus, rpcContract } from './server';
import { costRange, usd, PRICING_URL, type CostEstimate } from './cost';

function tokens(value: number | null | undefined): string {
  return value == null ? 'Not reported' : value.toLocaleString();
}
function timestamp(value: number | null | undefined): string {
  return value == null ? 'Unknown' : new Date(value).toLocaleString();
}
const explanation = 'Read/write totals cover the latest turn through its last usage report. Expanded details show each request and cache use on the first request. Reports may combine requests. These counts do not measure live cache size.';

export function cacheResult(readTokens: number | null | undefined): 'hit' | 'miss' | 'unknown' {
  if (readTokens == null || !Number.isFinite(readTokens) || readTokens < 0) return 'unknown';
  return readTokens > 0 ? 'hit' : 'miss';
}

export function LastCacheUse({ readTokens }: { readTokens: number | null | undefined }) {
  const result = cacheResult(readTokens);
  return <span className={result === 'hit' ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
    {result === 'hit' ? 'Yes — provider reported cache reads' : result === 'miss' ? 'No — provider reported zero cache reads' : 'Not reported by provider'}
  </span>;
}

export function remainingTime(expiresAt: number | null | undefined, now: number): string {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return 'TTL not reported';
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds <= 0) return 'Estimated TTL elapsed';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `~${hours ? `${hours}h ` : ''}${minutes}m ${remainder.toString().padStart(2, '0')}s left`;
}

function useRemainingTime(expiresAt: number | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return {
    text: remainingTime(expiresAt, now),
    color: expiresAt == null || !Number.isFinite(expiresAt) ? 'text-muted-foreground'
      : expiresAt > now ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400',
  };
}

const assumptionNote = 'Assumes 30 minutes after the latest reported cache read or write. The Codex provider did not report its actual cache policy. This is an estimate, not confirmation that the cache is valid or expired.';
function TimeLeft({ remaining, assumed }: { remaining: ReturnType<typeof useRemainingTime>; assumed: boolean }) {
  return <span className={remaining.color} title={assumed ? assumptionNote : 'Estimated from provider telemetry; not confirmed live cache state.'}>
    {remaining.text}{assumed ? ' · assumed 30m' : ''}
  </span>;
}

function useThreadCache(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ threadId: string; status: CacheStatus | null; error: boolean } | null>(null);
  const [fetching, setFetching] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setFetching(true);
    try {
      const status = await rpc.call('status', { threadId });
      if (mounted.current && current === request.current) setState({ threadId, status, error: false });
    } catch {
      if (mounted.current && current === request.current) {
        setState(previous => ({ threadId, status: previous?.threadId === threadId ? previous.status : null, error: true }));
      }
    } finally {
      if (mounted.current && current === request.current) setFetching(false);
    }
  }, [rpc, threadId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { mounted.current = false; ++request.current; clearInterval(timer); };
  }, [refresh]);
  useRealtime('changed', () => { if (mounted.current) void refresh(); });
  const current = state?.threadId === threadId ? state : null;
  return { status: current?.status ?? null, error: current?.error ?? false, fetching, refresh };
}

function KeepaliveControls({ threadId, status, refresh }: { threadId: string; status: CacheStatus | null; refresh: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const watch = status?.watch;
  const active = watch && !watch.disabled && watch.until > Date.now();
  async function change(enable: boolean) {
    setBusy(true); setError('');
    try {
      if (enable) await rpc.call('start', { threadId, durationHours: Number(hours) });
      else await rpc.call('stop', { threadId });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update keepalive.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 border-t px-3 pt-2 text-xs">
    <p>Keepalive: {active ? 'Enabled' : watch?.disabled ? 'Paused' : watch ? 'Expired' : 'Off'}</p>
    {watch && <p className="text-muted-foreground">Ends: {timestamp(watch.until)} · {watch.sent} pings</p>}
    {active && <p className="text-muted-foreground">Next ping: {status?.nextPingAt == null ? 'Waiting for fresh expiry telemetry' : timestamp(status.nextPingAt)}</p>}
    <p className="text-muted-foreground">Ordinary paid turns · 5 minutes before estimated expiry{status?.expirySource === 'codex-assumption' ? ' · assumed 30m TTL' : ''}.</p>
    <div className="flex flex-wrap items-center gap-2">
      <label>Hours <input aria-label="Keepalive duration (hours)" type="number" min="0.25" max="24" step="0.25" value={hours} onChange={e => setHours(e.target.value)} className="w-16 rounded border bg-background px-1 py-0.5" /></label>
      <button type="button" disabled={busy || !status || !Number.isFinite(Number(hours)) || Number(hours) < 0.25 || Number(hours) > 24} onClick={() => void change(true)} className="rounded border px-2 py-1 disabled:opacity-50">{active ? 'Renew paid keepalive' : 'Enable paid keepalive'}</button>
      <button type="button" disabled={busy} onClick={() => void change(false)} className="rounded border px-2 py-1 disabled:opacity-50">Stop keepalive</button>
    </div>
    {(error || watch?.error) && <p role="alert" className="text-destructive">{error || watch?.error}</p>}
  </div>;
}

export function CostDetails({ cost }: { cost: CostEstimate | null | undefined }) {
  if (!cost) return null;
  return <div className="space-y-2 border-t pt-2 text-xs" aria-label="Estimated turn cost">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">Turn cost (API estimate)</dt><dd className="text-right tabular-nums">{costRange(cost)}</dd>
      {cost.minUsd !== null && <>
        <dt className="text-muted-foreground">Cache read savings (estimate)</dt><dd className="text-right tabular-nums">{usd(cost.readSavingsUsd)}</dd>
        <dt className="text-muted-foreground">Turn input cache hit</dt><dd className="text-right tabular-nums">{cost.hitRate === null ? 'No input tokens' : `${(cost.hitRate * 100).toFixed(1)}%`}</dd>
      </>}
      {cost.model && <><dt className="text-muted-foreground">Cost model</dt><dd className="break-all text-right">{cost.model}</dd></>}
    </dl>
    <p className="text-muted-foreground">{cost.note}</p>
    <p className="text-muted-foreground">USD · <a href={cost.pricingUrl ?? PRICING_URL} target="_blank" rel="noreferrer" className="underline">{cost.pricingLabel ?? 'OpenAI Standard API rates'}</a> · {cost.pricingDate}</p>
  </div>;
}

export function TurnUsageDetails({ turn }: { turn: TurnUsage | null | undefined }) {
  if (!turn) return null;
  const thousands = (value: number | null) => value === null ? '?' : `${Math.round(value / 1000)}k`;
  const visibleSteps = (key: 'readTokens' | 'writeTokens') =>
    turn.steps.filter(step => step.source !== 'aggregate-remainder' || step[key] !== 0);
  const equation = (key: 'readTokens' | 'writeTokens') =>
    `${visibleSteps(key).map(step => `${thousands(step[key])}${step.combined || step.source === 'aggregate-remainder' ? '*' : ''}${step.incomplete && step.source !== 'aggregate-remainder' ? '†' : ''}`).join(' + ') || '0k'} = ${thousands(turn[key])}`;
  const displayed = [...visibleSteps('readTokens'), ...visibleSteps('writeTokens')];
  const hasCombined = displayed.some(step => step.combined || step.source === 'aggregate-remainder');
  const hasIncomplete = displayed.some(step => step.incomplete && step.source !== 'aggregate-remainder');
  const sources = turn.steps.map((step, index) => `${index + 1}: ${step.source ?? 'report'}${step.incomplete && step.source !== 'aggregate-remainder' ? ' (incomplete)' : ''} · ${step.model ?? 'model unreported'} · ${step.messageId ?? 'no message ID'} · cache ${step.combined ? 'combined/unknown request' : cacheResult(step.readTokens)}`).join('\n');
  return <div className="space-y-2 border-t pt-2 text-xs" aria-label="Per-request cache usage">
    {turn.note && <p className="text-muted-foreground">{turn.note}</p>}
    {turn.steps.length > 0 && <>
      <p title={sources} className="break-words font-mono tabular-nums">Read (≈): {equation('readTokens')}</p>
      <p title={sources} className="break-words font-mono tabular-nums">Written (≈): {equation('writeTokens')}</p>
      {(hasCombined || hasIncomplete) && <p className="text-muted-foreground">{hasCombined ? '* Combined or unattributed usage, not one request.' : ''}{hasCombined && hasIncomplete ? ' ' : ''}{hasIncomplete ? '† Incomplete observed request.' : ''}</p>}
      <p className="text-muted-foreground">k = 1,000 tokens, rounded. ? = unreported. Written: provider-reported counts; zero does not prove no cache was created.</p>
    </>}
  </div>;
}

function CachePanel({ threadId, card = false, sessionAction }: { threadId: string; card?: boolean; sessionAction?: ReactNode }) {
  const { status, error, fetching, refresh } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const rows: [string, ReactNode][] = [
    ['Cache used (first request)', <LastCacheUse readTokens={status?.turn?.firstReadTokens} />],
    ['Turn cache read', tokens(status?.turn?.readTokens)],
    ['Turn cache written', tokens(status?.turn?.writeTokens)],
    ['Last report', sample ? timestamp(sample.at) : 'Not reported'],
    ['Time left (estimate)', <TimeLeft remaining={remaining} assumed={assumed} />],
    ['Estimated expiry', <span className={remaining.color}>{timestamp(status?.estimatedExpiresAt)}</span>],
  ];
  return <div className={card ? 'space-y-1' : 'space-y-2 p-3 text-xs'} aria-label="Thread cache usage">
    {sessionAction && <div className="px-3 pb-2">{sessionAction}</div>}
    {!status && !error ? <p className="px-3 text-xs text-muted-foreground">Loading cache usage…</p> : card ? rows.map(([label, value]) =>
      <ContextRow key={label} label={label} trailing={<span className="tabular-nums">{value}</span>} />,
    ) : <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}
    </dl>}
    {error && <p role="status" className="px-3 text-xs text-muted-foreground">Cache usage unavailable.{status ? ' Showing the last report.' : ''}</p>}
    <div className="flex items-center justify-between gap-2 px-3 pt-1 text-xs text-muted-foreground">
      <span title={explanation}>Provider-reported cache use</span>
      <button type="button" aria-label="Refresh cache usage" title="Refresh cache usage" disabled={fetching} onClick={() => void refresh()} className="shrink-0 rounded p-1 hover:text-foreground disabled:opacity-50">
        <Icon name="RotateCcw" className={`size-3.5${fetching ? ' animate-spin' : ''}`} />
      </button>
    </div>
    <TurnUsageDetails turn={status?.turn} />
    <CostDetails cost={status?.cost} />
    <KeepaliveControls key={threadId} threadId={threadId} status={status} refresh={refresh} />
  </div>;
}

export function ThreadCacheCard({ threadId, sessionAction }: ExperimentalThreadContextCardProps & { sessionAction?: ReactNode }) {
  return <CachePanel key={threadId} threadId={threadId} sessionAction={sessionAction} card />;
}
export function ThreadCacheSummary({ threadId, onToggle, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { status, error } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const compact = (value: number | null | undefined) => value == null ? '?' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const turn = status?.turn;
  const label = turn?.steps.length ? `Cache: ${compact(turn.readTokens)} read · ${compact(turn.writeTokens)} written` : error ? 'Cache unavailable' : status ? 'Cache: waiting for turn usage' : 'Loading cache…';
  return <button type="button" onClick={onToggle} aria-expanded={isExpanded} title={`${label} (whole turn)\nReported: ${timestamp(sample?.at)}\nTurn cache read: ${tokens(turn?.readTokens)} tokens\nTurn cache written: ${tokens(turn?.writeTokens)} tokens\n${remaining.text}\nEstimated expiry: ${timestamp(status?.estimatedExpiresAt)}${assumed ? `\n${assumptionNote}` : ''}${error && sample ? '\nReport may be outdated' : ''}\n${explanation}`} className={`ml-auto flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-left text-xs transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isExpanded ? 'text-foreground' : 'text-muted-foreground'}`}>
    <Icon name="Database" className="size-3.5 shrink-0" /><span className="truncate">{label}{sample ? <> · <TimeLeft remaining={remaining} assumed={assumed} /></> : null}{error && sample ? ' · stale' : ''}</span>
    <Icon name={isExpanded ? 'ChevronUp' : 'ChevronDown'} aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
  </button>;
}
export function ThreadCacheDetails({ threadId, isExpanded, sessionAction }: ExperimentalThreadContextSegmentProps & { sessionAction?: ReactNode }) {
  return isExpanded ? <div role="region" aria-label="Cache details" className="flex min-h-0 flex-col overflow-hidden" style={{ maxHeight: 'min(50dvh, 28rem)' }}>
    <div className="min-h-0 overflow-y-auto overscroll-contain"><CachePanel key={threadId} threadId={threadId} sessionAction={sessionAction} /></div>
  </div> : null;
}
