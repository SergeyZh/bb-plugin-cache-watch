import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  experimental_Icon as Icon,
  experimental_ThreadContextCardRow as ContextRow,
  useRealtime, useRpc,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentProps,
} from '@get-bb/plugin-sdk/app';
import type { CacheStatus, rpcContract } from './server';

function tokens(value: number | null | undefined): string {
  return value == null ? 'Not reported' : value.toLocaleString();
}
function timestamp(value: number | null | undefined): string {
  return value == null ? 'Unknown' : new Date(value).toLocaleString();
}
const explanation = 'Latest provider usage report; may combine several requests in one turn. These counts do not measure the size of a live cache. Viewing this panel does not warm the cache.';

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

function CachePanel({ threadId, card = false }: { threadId: string; card?: boolean }) {
  const { status, error, fetching, refresh } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const rows: [string, ReactNode][] = [
    ['Cache read', tokens(sample?.readTokens)],
    ['Cache written', tokens(sample?.writeTokens)],
    ['Last report', sample ? timestamp(sample.at) : 'Not reported'],
    ['Time left (estimate)', <TimeLeft remaining={remaining} assumed={assumed} />],
    ['Estimated expiry', <span className={remaining.color}>{timestamp(status?.estimatedExpiresAt)}</span>],
  ];
  return <div className={card ? 'space-y-1' : 'space-y-2 p-3 text-xs'} aria-label="Thread cache usage">
    {!status && !error ? <p className="px-3 text-xs text-muted-foreground">Loading cache usage…</p> : card ? rows.map(([label, value]) =>
      <ContextRow key={label} label={label} trailing={<span className="tabular-nums">{value}</span>} />,
    ) : <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}
    </dl>}
    {error && <p role="status" className="px-3 text-xs text-muted-foreground">Cache usage unavailable.{status ? ' Showing the last report.' : ''}</p>}
    <div className="flex items-center justify-between gap-2 px-3 pt-1 text-xs text-muted-foreground">
      <span title={explanation}>Latest report · not live cache state</span>
      <button type="button" aria-label="Refresh cache usage" title="Refresh cache usage" disabled={fetching} onClick={() => void refresh()} className="shrink-0 rounded p-1 hover:text-foreground disabled:opacity-50">
        <Icon name="RotateCcw" className={`size-3.5${fetching ? ' animate-spin' : ''}`} />
      </button>
    </div>
  </div>;
}

export function ThreadCacheCard({ threadId }: ExperimentalThreadContextCardProps) {
  return <CachePanel key={threadId} threadId={threadId} card />;
}
export function ThreadCacheSummary({ threadId, onToggle, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { status, error } = useThreadCache(threadId);
  const sample = status?.sample;
  const remaining = useRemainingTime(status?.estimatedExpiresAt);
  const assumed = status?.expirySource === 'codex-assumption';
  const compact = (value: number | null | undefined) => value == null ? '?' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const label = sample ? `Cache: ${compact(sample.readTokens)} read · ${compact(sample.writeTokens)} written` : error ? 'Cache unavailable' : status ? 'Cache: no usage reported' : 'Loading cache…';
  return <button type="button" onClick={onToggle} aria-expanded={isExpanded} title={`${label}\n${remaining.text}\nEstimated expiry: ${timestamp(status?.estimatedExpiresAt)}${assumed ? `\n${assumptionNote}` : ''}${error && sample ? '\nReport may be outdated' : ''}\n${explanation}`} className="ml-auto inline-flex min-w-0 items-center justify-end gap-1.5 text-right text-xs text-muted-foreground hover:text-foreground">
    <Icon name="Database" className="size-3.5 shrink-0" /><span className="truncate">{label}{sample ? <> · <TimeLeft remaining={remaining} assumed={assumed} /></> : null}{error && sample ? ' · stale' : ''}</span>
  </button>;
}
export function ThreadCacheDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  return isExpanded ? <CachePanel key={threadId} threadId={threadId} /> : null;
}
