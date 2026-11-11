import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  experimental_Icon as Icon,
  experimental_ThreadContextCardRow as ContextRow,
  useRealtime, useRpc, useSettings,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentProps,
} from '@get-bb/plugin-sdk/app';
import { defaultStatusTemplate, renderStatusParts, templateData, type StatusTextPart } from './status-template';
import { StatusTemplateText } from './status-template-ui';
import { useStatusTemplate } from './template-settings';
import type { TurnUsage, WriteLifetimes } from './turn-usage';
import type { CacheStatus, rpcContract } from './server';
import { costRange, usd, PRICING_URL, type CostEstimate } from './cost';

function tokens(value: number | null | undefined): string {
  return value == null ? 'Not reported' : value.toLocaleString();
}
function timestamp(value: number | null | undefined): string {
  return value == null ? 'Unknown' : new Date(value).toLocaleString();
}
const explanation = 'Read/write totals cover the latest turn through its last usage report. Expanded details show each request and cache use on the first request. Reports may combine requests. These counts do not measure live cache size.';

/** e.g. "5m 0 · 1h 12,000 · unknown 300"; the unknown part is omitted when zero. */
export function writeLifetimesText(lifetimes: WriteLifetimes, format: (value: number) => string = value => value.toLocaleString()): string {
  return `5m ${format(lifetimes.fiveMinuteTokens)} · 1h ${format(lifetimes.oneHourTokens)}${lifetimes.unknownTokens ? ` · unknown ${format(lifetimes.unknownTokens)}` : ''}`;
}

export function cacheResult(readTokens: number | null | undefined): 'hit' | 'miss' | 'unknown' {
  if (readTokens == null || !Number.isFinite(readTokens) || readTokens < 0) return 'unknown';
  return readTokens > 0 ? 'hit' : 'miss';
}

/** Share of the first request's prompt read from cache, e.g. "41%"; null when unknown or not a hit. */
export function firstShare(turn: Pick<TurnUsage, 'firstReadTokens' | 'firstPromptTokens'> | null | undefined): string | null {
  const read = turn?.firstReadTokens, prompt = turn?.firstPromptTokens;
  return read == null || prompt == null || read <= 0 || prompt < read ? null : `${Math.floor(read / prompt * 100)}%`;
}
/** "hit 41%", "miss" or "unknown": a hit is usually partial, so show how much of the prompt it covered. */
export function firstLabel(turn: Pick<TurnUsage, 'firstReadTokens' | 'firstPromptTokens'> | null | undefined): string {
  const share = firstShare(turn);
  return `${cacheResult(turn?.firstReadTokens)}${share ? ` ${share}` : ''}`;
}
/** "3 requests" for individually reported requests, otherwise "2 reports". */
export function requestCount(turn: TurnUsage): string {
  const requests = turn.steps.filter(step => step.source === 'request').length;
  const n = requests || turn.steps.length;
  return `${n} ${requests ? 'request' : 'report'}${n === 1 ? '' : 's'}`;
}

export function LastCacheUse({ turn }: { turn: Pick<TurnUsage, 'firstReadTokens' | 'firstPromptTokens'> | null | undefined }) {
  const result = cacheResult(turn?.firstReadTokens);
  const share = firstShare(turn);
  return <span className={result === 'hit' ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
    {share ? `${turn!.firstReadTokens === turn!.firstPromptTokens ? 'Yes' : 'Partly'} — ${tokens(turn!.firstReadTokens)} of ${tokens(turn!.firstPromptTokens)} prompt tokens read from cache (${share})`
      : result === 'hit' ? 'Yes — provider reported cache reads' : result === 'miss' ? 'No — provider reported zero cache reads' : 'Not reported by provider'}
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
    now,
    text: remainingTime(expiresAt, now),
    color: expiresAt == null || !Number.isFinite(expiresAt) ? 'text-muted-foreground'
      : expiresAt > now ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400',
  };
}

const assumptionNote = 'Assumes 30 minutes after the latest reported cache read or write. The Codex provider did not report its actual cache policy. This is an estimate, not confirmation that the cache is valid or expired.';
function TimeLeft({ remaining, assumed }: { remaining: ReturnType<typeof useRemainingTime>; assumed: boolean }) {
  return <span className={`font-mono tabular-nums whitespace-nowrap ${remaining.color}`} title={assumed ? assumptionNote : 'Estimated from provider telemetry; not confirmed live cache state.'}>
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

function KeepaliveControls({ threadId, status, unavailable, refresh }: { threadId: string; status: CacheStatus | null; unavailable: boolean; refresh: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [edited, setHours] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const watch = status?.watch;
  // The lease stores its end, not its duration; show the duration it was set for.
  const lease = watch && Number.isFinite(watch.until - watch.armedAt) ? Math.round((watch.until - watch.armedAt) / 36_000) / 100 : null;
  const hours = edited ?? String(lease === null ? 6 : Math.min(24, Math.max(1, Math.round(lease))));
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
    {watch && <p className="text-muted-foreground">Ends: {timestamp(watch.until)}{lease === null ? '' : ` · set for ${lease} h`} · {watch.sent} pings</p>}
    {active && <p className="text-muted-foreground">Next ping: {status?.nextPingAt == null ? 'Waiting for fresh expiry telemetry' : timestamp(status.nextPingAt)}</p>}
    <p className="text-muted-foreground">Ordinary paid turns · 5 minutes before estimated expiry{status?.expirySource === 'codex-assumption' ? ' · assumed 30m TTL' : ''}.</p>
    <div className="flex flex-wrap items-center gap-2">
      <label title="Applies when you click Enable or Renew; the lease then runs for this many hours from that moment.">Hours <input aria-label="Keepalive duration (hours)" type="number" min="1" max="24" step="1" value={hours} onChange={e => setHours(e.target.value)} className="w-16 rounded border bg-background px-1 py-0.5" /></label>
      <button type="button" disabled={busy || !status || !Number.isFinite(Number(hours)) || Number(hours) < 1 || Number(hours) > 24} onClick={() => void change(true)} className="rounded border px-2 py-1 disabled:opacity-50">{active ? 'Renew paid keepalive' : 'Enable paid keepalive'}</button>
      {/* Nothing to stop while keepalive is off. Keep the control when the state
          could not be read, so paid pings can always be stopped. */}
      {(watch || (!status && unavailable)) && <button type="button" disabled={busy} onClick={() => void change(false)} className="rounded border px-2 py-1 disabled:opacity-50">{!watch || active ? 'Stop keepalive' : 'Clear keepalive'}</button>}
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
      {cost.remainderModel && <><dt className="text-muted-foreground">Usage without a model (estimate)</dt><dd className="break-all text-right">priced as {cost.remainderModel}*</dd></>}
    </dl>
    <p className="text-muted-foreground">{cost.note}</p>
    <p className="text-muted-foreground">USD · <a href={cost.pricingUrl ?? PRICING_URL} target="_blank" rel="noreferrer" className="underline">{cost.pricingLabel ?? 'OpenAI Standard API rates'}</a> · {cost.pricingDate}</p>
  </div>;
}

export const TELEMETRY_PROVIDER_URL = 'https://github.com/SergeyZh/bb-plugin-claude-code-telemetry';
/** Built-in Claude Code reports only turn aggregates; suggest the telemetry provider. */
export function TelemetryProviderHint({ providerId }: { providerId: string | null | undefined }) {
  if (providerId !== 'claude-code') return null;
  return <p className="border-t pt-2 text-xs text-muted-foreground">
    Built-in Claude Code reports only turn totals. For per-request cache hits, 5m/1h cache-write lifetimes and exact costs,
    use the <a href={TELEMETRY_PROVIDER_URL} target="_blank" rel="noreferrer" className="underline">Claude Code Telemetry provider</a>.
  </p>;
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
      {turn.writeLifetimes && <p className="break-words font-mono tabular-nums">Written by lifetime (≈): {writeLifetimesText(turn.writeLifetimes, value => thousands(value))}</p>}
      {(hasCombined || hasIncomplete) && <p className="text-muted-foreground">{hasCombined ? '* Combined or unattributed usage, not one request.' : ''}{hasCombined && hasIncomplete ? ' ' : ''}{hasIncomplete ? '† Incomplete observed request.' : ''}</p>}
      <p className="text-muted-foreground">k = 1,000 tokens, rounded. ? = unreported. Written: provider-reported counts; zero does not prove no cache was created.</p>
    </>}
  </div>;
}

function CachePanel({ threadId, card = false, hideWhenEarly = false, sessionAction }: { threadId: string; card?: boolean; hideWhenEarly?: boolean; sessionAction?: ReactNode }) {
  const { status, error, fetching, refresh } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const threshold = useCacheDisplayThreshold();
  if (hideWhenEarly && !cacheIsVisible(status?.estimatedExpiresAt, remaining.now, threshold)) return null;
  const rows: [string, ReactNode][] = [
    ['Cache used (first request)', <LastCacheUse turn={status?.turn} />],
    ['Turn cache read', tokens(status?.turn?.readTokens)],
    ['Turn cache written', tokens(status?.turn?.writeTokens)],
    ...status?.turn?.writeLifetimes ? [['Written by lifetime', writeLifetimesText(status.turn.writeLifetimes)] as [string, ReactNode]] : [],
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
    <TelemetryProviderHint providerId={status?.providerId} />
    <CostDetails cost={status?.cost} />
    <KeepaliveControls key={threadId} threadId={threadId} status={status} unavailable={error} refresh={refresh} />
  </div>;
}

export function cacheIsVisible(expiresAt: number | null | undefined, now: number, threshold: number) {
  return threshold <= 0 || expiresAt == null || !Number.isFinite(expiresAt) || expiresAt - now <= threshold * 1000;
}

export function useCacheDisplayThreshold() {
  const value = useSettings().values?.cacheShowBelowSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function useCachePlacement() {
  return useSettings().values?.cachePlacement === 'header' ? 'header' : 'context';
}

export function ThreadCacheCard({ threadId, sessionAction, hideWhenEarly }: ExperimentalThreadContextCardProps & { sessionAction?: ReactNode; hideWhenEarly?: boolean }) {
  return <CachePanel key={threadId} threadId={threadId} sessionAction={sessionAction} hideWhenEarly={hideWhenEarly} card />;
}
export function ThreadCacheSummary({ threadId, onToggle, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { status, error } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const threshold = useCacheDisplayThreshold();
  const { template } = useStatusTemplate('context');
  if (!isExpanded && !cacheIsVisible(status?.estimatedExpiresAt, remaining.now, threshold)) return null;
  const turn = status?.turn;
  const data = templateData(status, remaining.now, error);
  let parts: StatusTextPart[];
  try { parts = renderStatusParts(template, data); }
  catch { parts = renderStatusParts(defaultStatusTemplate('context'), data); }
  const label = parts.map(part => part.text).join('');
  if (!label && !isExpanded) return null;
  return <button type="button" onClick={onToggle} aria-expanded={isExpanded} title={`${label} (whole turn)\nReported: ${timestamp(sample?.at)}\nTurn cache read: ${tokens(turn?.readTokens)} tokens\nTurn cache written: ${tokens(turn?.writeTokens)} tokens\n${remaining.text}\nEstimated expiry: ${timestamp(status?.estimatedExpiresAt)}${assumed ? `\n${assumptionNote}` : ''}${error && sample ? '\nReport may be outdated' : ''}\n${explanation}`} className={`ml-auto flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-left text-xs transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isExpanded ? 'text-foreground' : 'text-muted-foreground'}`}>
    <Icon name="Database" className="size-3.5 shrink-0" /><span className="truncate">{label ? <StatusTemplateText parts={parts} monoClassName={remaining.color} /> : 'Cache details'}</span>
    <Icon name={isExpanded ? 'ChevronUp' : 'ChevronDown'} aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
  </button>;
}
export function ThreadCacheDetails({ threadId, isExpanded, sessionAction }: ExperimentalThreadContextSegmentProps & { sessionAction?: ReactNode }) {
  return isExpanded ? <div role="region" aria-label="Cache details" className="flex min-h-0 flex-col overflow-hidden" style={{ maxHeight: 'min(50dvh, 28rem)' }}>
    <div className="min-h-0 overflow-y-auto overscroll-contain"><CachePanel key={threadId} threadId={threadId} sessionAction={sessionAction} /></div>
  </div> : null;
}
