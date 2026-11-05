import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc, type ExperimentalMessageMetadataProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { SavedTurn, SessionStatistics } from './statistics';
import { CostDetails, LastCacheUse, TurnUsageDetails, cacheResult, writeLifetimesText } from './thread-cache';
import { compactCost, costRange, usd } from './cost';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog';

const providerName = (providerId: string | undefined) => providerId === 'claude-code-telemetry' ? 'Claude Code Telemetry' : providerId === 'claude-code' ? 'Claude Code' : providerId === 'codex' ? 'Codex' : providerId === 'central-codex' ? 'Central Codex' : providerId ?? 'Provider';
const tokens = (n: number | null) => n === null ? 'Not reported' : n.toLocaleString();
const compact = (n: number | null) => n === null ? '?' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
function SavedTurnDetails({ saved }: { saved: SavedTurn }) {
  return <div className="space-y-3 text-sm">
    <p>{providerName(saved.providerId ?? saved.cost.providerId)} · {new Date(saved.startedAt).toLocaleString()} · {saved.completed ? 'Completed' : 'Usage so far'}{saved.keepalive ? ' · Keepalive' : ''}</p>
    <p>First request: <LastCacheUse readTokens={saved.turn.firstReadTokens} /></p>
    <p>{(saved.providerId === 'claude-code' || saved.providerId === 'claude-code-telemetry') ? 'Input (uncached)' : 'Input'}: {tokens(saved.turn.inputTokens)} · Output: {tokens(saved.turn.outputTokens)}</p>
    <TurnUsageDetails turn={saved.turn} />
    <CostDetails cost={saved.cost} />
  </div>;
}
function TurnMarker({ threadId, turnId }: { threadId: string; turnId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<SavedTurn | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const latest = useRef<SavedTurn | null>(null);
  const live = useRef(false);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    try {
      const result = await rpc.call('turn', { threadId, turnId });
      if (!live.current || request !== version.current) return;
      latest.current = result; setSaved(result); setError(false);
    } catch { if (live.current && request === version.current) setError(true); }
  }, [rpc, threadId, turnId]);
  useEffect(() => {
    live.current = true; void refresh();
    const timer = setInterval(() => { if (!latest.current?.completed) void refresh(); }, 30_000);
    return () => { live.current = false; version.current++; clearInterval(timer); };
  }, [refresh]);
  useRealtime('statistics-changed', (payload) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId && !latest.current?.completed) void refresh();
  });
  const label = saved ? `Cache · first: ${cacheResult(saved.turn.firstReadTokens)} · ${compact(saved.turn.readTokens)} read${saved.cost.minUsd !== null ? ` · ~${compactCost(saved.cost)}` : ''}`
    : error ? 'Cache · unavailable' : 'Cache · collecting';
  return <>
    <button type="button" aria-label={`Turn cache statistics: ${label}`} onClick={() => { setOpen(true); void refresh(); }}
      className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" title="Cache statistics for this response's turn">{label}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex max-h-[80dvh] flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Turn cache statistics</DialogTitle><DialogDescription>Saved telemetry for this response's turn. Cost is an API estimate.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && <p>Statistics could not be refreshed. {saved ? 'Showing saved data.' : ''}</p>}
        {saved ? <SavedTurnDetails saved={saved} /> : <p>Waiting for turn telemetry.</p>}
      </div>
    </DialogContent></Dialog>
  </>;
}
export function CacheMessageMetadata({ message }: ExperimentalMessageMetadataProps) {
  return message.role === 'assistant' && message.turnId
    ? <TurnMarker key={`${message.threadId}:${message.turnId}`} threadId={message.threadId} turnId={message.turnId} /> : null;
}

export function SessionStatisticsButton({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="rounded border px-2 py-1 text-xs hover:bg-muted">Session statistics</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-w-3xl flex-col overflow-hidden" style={{ maxHeight: 'min(85dvh, 48rem)' }}>
        <DialogHeader><DialogTitle>Session cache statistics</DialogTitle><DialogDescription>Saved totals and turn history for this session. Cost is an API estimate.</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Session statistics scroll area">
          {open && <SessionStatisticsPanel key={threadId} threadId={threadId} />}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function SessionStatisticsPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<SessionStatistics | null>(null);
  const [error, setError] = useState(false);
  const [older, setOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const version = useRef(0);
  const refresh = useCallback(async (beforeSeq?: number) => {
    const request = ++version.current; setBusy(true);
    try {
      const result = await rpc.call('session', { threadId, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
      if (!live.current || version.current !== request) return;
      setData(previous => beforeSeq === undefined || !previous ? result : { ...result, turns: [...previous.turns, ...result.turns] });
      setOlder(beforeSeq !== undefined); setError(false);
    } catch { if (live.current && version.current === request) setError(true); }
    finally { if (live.current && version.current === request) setBusy(false); }
  }, [rpc, threadId]);
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; version.current++; }; }, [refresh]);
  useEffect(() => { if (older) return; const timer = setInterval(() => void refresh(), 30_000); return () => clearInterval(timer); }, [older, refresh]);
  const total = (value: { known: number; unknownTurns: number }, money = false) =>
    `${money ? usd(value.known) : tokens(value.known)}${value.unknownTurns ? ` known; ${value.unknownTurns} turns unreported` : ''}`;
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Session cache statistics">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Session statistics</h2>
      <button type="button" disabled={busy} className="rounded border px-2 py-1 text-xs" onClick={() => void refresh()}>Refresh statistics</button></div>
    {error && <p className="text-muted-foreground">Session statistics unavailable.{data ? ' Showing saved data.' : ''}</p>}
    {!data ? !error && <p>Loading saved statistics…</p> : <>
      {data.unattributedReports > 0 && <p className="text-muted-foreground">{data.unattributedReports} reports lack a turn boundary and are excluded from totals.</p>}
      <p>{providerName(data.providerId)} · {data.totalTurns} turns · {data.keepaliveTurns} keepalive turns</p>
      <dl className="grid grid-cols-2 gap-2">
        <dt>{(data.providerId === 'claude-code' || data.providerId === 'claude-code-telemetry') ? 'Input tokens (uncached)' : 'Input tokens'}</dt><dd>{total(data.input)}</dd><dt>Output tokens</dt><dd>{total(data.output)}</dd>
        <dt>Cache read</dt><dd>{total(data.read)}</dd><dt>Cache written (reported)</dt><dd>{total(data.written)}</dd>
        {data.writeLifetimeTurns > 0 && <><dt>Cache written, 5m lifetime</dt><dd>{total(data.written5m)}</dd>
          <dt>Cache written, 1h lifetime</dt><dd>{total(data.written1h)}</dd>
          {data.writtenUnknownLifetime.known > 0 && <><dt>Cache written, lifetime unreported</dt><dd>{total(data.writtenUnknownLifetime)}</dd></>}
          {data.writeLifetimeTurns < data.totalTurns && <><dt>Lifetime split covers</dt><dd>{data.writeLifetimeTurns} of {data.totalTurns} turns; other turns report no lifetimes</dd></>}</>}
        {data.keepaliveTurns > 0 && <><dt>Keepalive cost (included)</dt><dd>{total(data.keepaliveCostMin, true)}{data.keepaliveCostMax.known !== data.keepaliveCostMin.known ? ` – ${usd(data.keepaliveCostMax.known)}` : ''}</dd></>}
        <dt>Cost (API estimate)</dt><dd>{total(data.costMin, true)}{data.costMax.known !== data.costMin.known ? ` – ${usd(data.costMax.known)}` : ''}</dd>
      </dl>
      {data.providerId === 'claude-code' && <p className="text-xs text-muted-foreground">Claude Code input excludes cache reads and writes, which are counted separately. First-request cache use is not exposed by the aggregate report.</p>}
      <p className="text-xs text-muted-foreground">Includes usage reported so far and keepalive. Missing values are excluded from known subtotals and counted separately. Cost uses each turn's saved API rate estimate.</p>
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {data.turns.map(saved => <details key={saved.turnId} className="rounded border p-2">
          <summary className="cursor-pointer text-xs">{new Date(saved.startedAt).toLocaleString()} · first: {cacheResult(saved.turn.firstReadTokens)} · {compact(saved.turn.readTokens)} read · {compact(saved.turn.writeTokens)} written{saved.turn.writeLifetimes ? ` (${writeLifetimesText(saved.turn.writeLifetimes, compact)})` : ''}{saved.keepalive ? ' · keepalive' : ''} · {costRange(saved.cost)}</summary>
          <div className="pt-3"><SavedTurnDetails saved={saved} /></div>
        </details>)}
      </div>
      {data.nextBeforeSeq !== null && <button type="button" disabled={busy} className="rounded border px-2 py-1" onClick={() => void refresh(data.nextBeforeSeq!)}>Load older turns</button>}
    </>}
  </section>;
}
