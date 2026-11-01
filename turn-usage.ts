import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
type Event = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
type Report = Extract<Event, { type: 'thread/tokenUsage/updated' }>;
type Counts = Report['data']['tokenUsage']['total'];

const count = z.number().int().nonnegative().nullable();
export const requestMetadataSchema = z.object({
  source: z.enum(['request', 'aggregate-remainder']), messageId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(), incomplete: z.boolean(),
  counts: z.object({ inputTokens: count, outputTokens: count,
    cacheReadInputTokens: count.optional(), cacheWriteInputTokens: count.optional() }),
});
export const turnUsageSchema = z.object({
  turnId: z.string().nullable(), readTokens: count, writeTokens: count,
  inputTokens: count, outputTokens: count,
  firstReadTokens: count, note: z.string().nullable(),
  steps: z.array(z.object({ seq: z.number(), at: z.number(), readTokens: count,
    writeTokens: count, inputTokens: count, outputTokens: count, combined: z.boolean(),
    source: z.enum(['request', 'aggregate-remainder', 'unattributed']).default('unattributed'),
    messageId: z.string().nullable().default(null), model: z.string().nullable().default(null),
    incomplete: z.boolean().default(false) })),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;
const number = (value: number | undefined): number | null =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
const reads = (counts: Counts) => number(counts.cacheReadInputTokens ?? counts.cachedInputTokens);
const difference = (current: number | null, previous: number | null) => current === null || previous === null ? null : current - previous;
const empty = (note: string, turnId: string | null = null): TurnUsage =>
  ({ turnId, steps: [], readTokens: null, writeTokens: null, inputTokens: null, outputTokens: null, firstReadTokens: null, note });
const sum = (counts: (number | null)[]) => counts.every((n): n is number => n !== null)
  ? counts.reduce((a, b) => a + b, 0) : null;
const same = (a: Counts, b: Counts) =>
  a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && reads(a) === reads(b)
  && a.cacheWriteInputTokens === b.cacheWriteInputTokens && a.reasoningOutputTokens === b.reasoningOutputTokens;

export function collectTurnUsage(rows: Event[], providerId = 'codex'): TurnUsage {
  const claude = providerId === 'claude-code' || providerId === 'claude-code-telemetry';
  const telemetry = providerId === 'claude-code-telemetry';
  const readCount = (counts: Counts) => claude ? number(counts.cacheReadInputTokens) : reads(counts);
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const latestStart = [...ordered].reverse().find(row => row.type === 'turn/started' && row.scope?.kind === 'turn');
  if (!latestStart || latestStart.scope.kind !== 'turn') return empty('Turn boundary unavailable in the last 500 relevant events.');
  const turnId = latestStart.scope.turnId;
  // A provider may announce the same turn again after reconnecting.
  const start = ordered.find(row => row.type === 'turn/started' && row.scope?.kind === 'turn' && row.scope.turnId === turnId)!;
  const reports = ordered.filter((row): row is Report => row.type === 'thread/tokenUsage/updated' && row.seq > start.seq);
  if (!reports.length) return empty('Waiting for the first usage report of this turn.', turnId);
  if (reports.some(row => row.scope?.kind !== 'turn' || row.scope.turnId !== turnId))
    return empty('Usage from different turns cannot be attributed safely.', turnId);
  const previous = [...ordered].reverse().find((row): row is Report => row.type === 'thread/tokenUsage/updated' && row.seq < start.seq);
  let prior = claude ? undefined : previous?.data.tokenUsage.total;
  let session = claude ? undefined : previous?.data.providerThreadId;
  const steps: TurnUsage['steps'] = [];
  // Extension state is THREAD-scoped; pair by event order, consuming at each
  // usage (including duplicates) so metadata cannot leak into a later report.
  const metadataByUsage = new Map<number, z.infer<typeof requestMetadataSchema>>();
  let pending: z.infer<typeof requestMetadataSchema> | null = null;
  for (const row of ordered) {
    if (row.seq <= start.seq) continue;
    if (row.type === 'thread/extensionState/updated' && row.data.kind === 'claude-code-telemetry/usage') {
      const parsed = requestMetadataSchema.safeParse(row.data.payload);
      pending = parsed.success ? parsed.data : null;
    } else if (row.type === 'thread/tokenUsage/updated') {
      if (pending) metadataByUsage.set(row.seq, pending);
      pending = null;
    }
  }
  for (const report of reports) {
    const { total, last } = report.data.tokenUsage;
    if (session !== undefined && session !== report.data.providerThreadId)
      return empty('Provider session changed; per-request counters are unavailable.', turnId);
    session = report.data.providerThreadId;
    if (prior && same(total, prior)) continue; // Duplicate or stale notification, not another request.
    const inputDelta = !claude && prior ? difference(number(total.inputTokens), number(prior.inputTokens)) : number(last.inputTokens);
    const outputDelta = !claude && prior ? difference(number(total.outputTokens), number(prior.outputTokens)) : number(last.outputTokens);
    const readDelta = !claude && prior ? difference(readCount(total), readCount(prior)) : readCount(last);
    const writeDelta = !claude && prior ? difference(number(total.cacheWriteInputTokens), number(prior.cacheWriteInputTokens)) : number(last.cacheWriteInputTokens);
    if ([inputDelta, outputDelta, readDelta, writeDelta].some(n => n !== null && n < 0))
      return empty('Usage counters reset; a complete turn sum is unavailable.', turnId);
    // A gap can contain multiple requests. Show the total delta, without claiming
    // that its cache hit belongs to the very first request of the group.
    const candidate = telemetry ? metadataByUsage.get(report.seq) : undefined;
    const metadata = candidate && candidate.counts.inputTokens === last.inputTokens
      && candidate.counts.outputTokens === last.outputTokens
      && (candidate.counts.cacheReadInputTokens ?? null) === (last.cacheReadInputTokens ?? null)
      && (candidate.counts.cacheWriteInputTokens ?? null) === (last.cacheWriteInputTokens ?? null) ? candidate : undefined;
    const individual = metadata?.source === 'request' && !metadata.incomplete && metadata.messageId !== null;
    const combined = claude && (!telemetry || !individual) || !claude && prior !== undefined && (inputDelta !== number(last.inputTokens)
      || outputDelta !== number(last.outputTokens) || readDelta !== reads(last));
    steps.push({ seq: report.seq, at: report.createdAt, readTokens: readDelta, writeTokens: writeDelta, inputTokens: inputDelta, outputTokens: outputDelta, combined,
      source: metadata?.source ?? 'unattributed', messageId: metadata?.messageId ?? null,
      model: metadata?.model ?? null, incomplete: metadata?.incomplete ?? telemetry });
    prior = total;
  }
  if (!steps.length) return empty('Waiting for new usage in this turn.', turnId);
  return { turnId, steps, inputTokens: sum(steps.map(step => step.inputTokens)), outputTokens: sum(steps.map(step => step.outputTokens)), readTokens: sum(steps.map(step => step.readTokens)),
    writeTokens: sum(steps.map(step => step.writeTokens)),
    firstReadTokens: steps[0].combined ? null : steps[0].readTokens,
    note: telemetry && steps.some(step => step.incomplete) ? 'Incomplete reports contain only observed tokens. Aggregate remainders may include subagents and are not individual requests.' : claude && !telemetry ? 'Claude Code reports aggregate usage per turn. First-request cache use is not exposed by this provider.' : steps.some(step => step.combined) ? 'Some reports combine requests; first-request cache use is unknown when the first report is combined.' : null };
}
