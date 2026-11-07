import { z } from 'zod';
import { collectTurnUsage, type WriteLifetimes } from './turn-usage';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
type ThreadEventRow = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];

export const PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
export const CLAUDE_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICING_DATE = '2026-11-01';
// Standard API USD / million tokens, short context. Never infer an unknown model's rate.
const rates: Record<string, { input: number; read: number; output: number }> = {
  'gpt-6-astra': { input: 10, read: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, read: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, read: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, read: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, read: 0.4, output: 20 },
};
export const costSchema = z.object({
  providerId: z.string().default('codex'),
  pricingUrl: z.string().url().default(PRICING_URL),
  pricingLabel: z.string().default('OpenAI Standard API rates'),
  model: z.string().nullable(), turnId: z.string().nullable(),
  minUsd: z.number().nullable(), maxUsd: z.number().nullable(),
  readSavingsUsd: z.number().nullable(), hitRate: z.number().nullable(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
  note: z.string(), pricingDate: z.string(),
  // Set when usage without a model was priced at this assumed model.
  remainderModel: z.string().nullable().optional(),
});
export type CostEstimate = z.infer<typeof costSchema>;
type Calculation = Omit<CostEstimate, 'providerId' | 'pricingUrl' | 'pricingLabel'>;
const unavailable = (note: string, model: string | null = null, turnId: string | null = null): Calculation => ({
  model, turnId, minUsd: null, maxUsd: null, readSavingsUsd: null, hitRate: null,
  inputTokens: null, outputTokens: null, note, pricingDate: PRICING_DATE,
});
const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;

// Input includes cache reads/writes for Codex. Reasoning is already included in output.
export function priceTokens(model: string, input: number, read: number, output: number, write: number | null) {
  const rate = rates[model];
  if (!rate || ![input, read, output, ...(write === null ? [] : [write])].every(valid)
    || read + (write ?? 0) > input) return null;
  const ordinary = input - read - (write ?? 0);
  const base = ordinary * rate.input + read * rate.read + output * rate.output;
  // Without write lifetime telemetry, bound the write premium by 30m and 12h rates.
  const minUsd = (base + (write ?? 0) * rate.input * 1.25) / 1e6;
  const maxUsd = write === null
    ? ((input - read) * rate.input * 2.5 + read * rate.read + output * rate.output) / 1e6
    : (base + write * rate.input * 2.5) / 1e6;
  return { minUsd, maxUsd, readSavingsUsd: read * (rate.input - rate.read) / 1e6,
    hitRate: input > 0 ? read / input : null };
}

function estimateCodexCost(providerId: string, rows: ThreadEventRow[]): Calculation {
  if (providerId !== 'codex' && providerId !== 'central-codex') return unavailable('Cost estimates currently support Codex providers only.');
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const descending = [...ordered].reverse();
  const latest = descending.find(row => row.type === 'thread/tokenUsage/updated');
  if (!latest || latest.type !== 'thread/tokenUsage/updated' || latest.scope?.kind !== 'turn')
    return unavailable('Waiting for turn-scoped token usage.');
  const pending = descending.find(row => row.type === 'turn/started' && row.scope?.kind === 'turn' && row.seq > latest.seq);
  if (pending?.scope.kind === 'turn') return unavailable('Waiting for usage in the new turn.', null, pending.scope.turnId);
  const turnId = latest.scope.turnId;
  const start = descending.find(row => row.type === 'turn/started' && row.scope.kind === 'turn' && row.scope.turnId === turnId && row.seq < latest.seq);
  if (!start) return unavailable('Turn boundary unavailable in the last 500 relevant events.', null, turnId);
  const rejected = new Set(ordered.flatMap(row => row.type === 'client/turn/rejected' ? [row.data.requestId] : []));
  const request = descending.find(row => row.seq < start.seq && row.type === 'client/turn/requested' && !rejected.has(row.data.requestId));
  const model = request?.type === 'client/turn/requested' ? request.data.execution.model : null;
  if (!model || !rates[model]) return unavailable('No verified API rate for the recorded model.', model, turnId);
  if (ordered.some(row => row.seq > start.seq && row.seq <= latest.seq && row.type === 'provider/modelFallback'))
    return unavailable('Model changed during this turn; a single rate would be inaccurate.', model, turnId);
  const reports = ordered.filter((row): row is Extract<ThreadEventRow, { type: 'thread/tokenUsage/updated' }> =>
    row.type === 'thread/tokenUsage/updated' && row.seq > start.seq && row.seq <= latest.seq);
  if (reports.some(row => row.scope.kind !== 'turn' || row.scope.turnId !== turnId || row.data.providerThreadId !== latest.data.providerThreadId))
    return unavailable('Interleaved usage cannot be attributed to this turn.', model, turnId);
  const previous = descending.find(row => row.seq < start.seq && row.type === 'thread/tokenUsage/updated');
  const first = reports[0]?.data.tokenUsage;
  if (!first) return unavailable('Token usage unavailable.', model, turnId);
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const;
  const baseline = previous?.type === 'thread/tokenUsage/updated' ? previous.data.tokenUsage.total : null;
  if (previous?.type === 'thread/tokenUsage/updated' && previous.data.providerThreadId !== latest.data.providerThreadId)
    return unavailable('Provider session changed; cumulative usage is not comparable.', model, turnId);
  const totals = latest.data.tokenUsage.total;
  const delta = Object.fromEntries(fields.map(key => [key, totals[key] - (baseline?.[key] ?? first.total[key] - first.last[key])])) as Record<typeof fields[number], number>;
  // Detect counter resets, even if the final total has grown above the initial baseline again.
  for (const key of fields) {
    let prior = baseline?.[key] ?? first.total[key] - first.last[key];
    for (const report of reports) {
      const current = report.data.tokenUsage.total[key];
      if (!valid(prior) || !valid(current) || current < prior)
        return unavailable('Usage counters reset or are incomplete.', model, turnId);
      prior = current;
    }
  }
  const firstWrite = first.total.cacheWriteInputTokens;
  const lastWrite = totals.cacheWriteInputTokens;
  const baselineWrite = baseline?.cacheWriteInputTokens ?? (firstWrite !== undefined && first.last.cacheWriteInputTokens !== undefined ? firstWrite - first.last.cacheWriteInputTokens : undefined);
  const write = lastWrite === undefined || baselineWrite === undefined ? null : lastWrite - baselineWrite;
  const price = priceTokens(model, delta.inputTokens, delta.cachedInputTokens, delta.outputTokens, write);
  if (!price) return unavailable('Token usage is incomplete or inconsistent.', model, turnId);
  return { ...price, model, turnId, inputTokens: delta.inputTokens, outputTokens: delta.outputTokens, pricingDate: PRICING_DATE,
    note: 'Latest turn through the last usage report. Standard API equivalent, short context; not a bill or subscription-limit estimate. Excludes tools, speed, regional and long-context surcharges.'
      + (write === null ? ' Cache-write count unavailable; range allows for unreported writes.' : write > 0 ? ' Range uses 30m–12h cache-write rates.' : '') };
}

// Anthropic input excludes both cache reads and writes. Rates are USD / MTok.
type ClaudeRate = { input: number; read: number; output: number };
// Models with a second rate card for requests whose prompt exceeds `threshold`.
const claudeLongPromptRates: Record<string, ClaudeRate & { threshold: number }> = {
  'claude-haiku-5-5': { threshold: 100_000, input: 0.5, read: 0.05, output: 2.5 },
};
const claudeRates: Record<string, ClaudeRate> = {
  'claude-fable-5-1': { input: 10, read: 0.25, output: 50 },
  'claude-fable-5': { input: 10, read: 1, output: 50 },
  'claude-opus-5-5': { input: 4, read: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, read: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, read: 0.01, output: 0.5 },
  'claude-opus-5': { input: 5, read: 0.5, output: 25 },
  'claude-opus-4-8': { input: 5, read: 0.5, output: 25 },
  'claude-opus-4-7': { input: 5, read: 0.5, output: 25 },
  'claude-opus-4-6': { input: 5, read: 0.5, output: 25 },
  'claude-opus-4-5': { input: 5, read: 0.5, output: 25 },
  'claude-opus-4-1': { input: 15, read: 1.5, output: 75 },
  'claude-opus-4': { input: 15, read: 1.5, output: 75 },
  'claude-sonnet-5': { input: 2, read: 0.2, output: 10 },
  'claude-sonnet-4-6': { input: 3, read: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, read: 0.3, output: 15 },
  'claude-sonnet-4': { input: 3, read: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, read: 0.1, output: 5 },
};
const claudeModelId = (model: string) => model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
// Writes cost 1.25× input for a 5-minute lifetime and 2× for one hour. Writes
// without a reported lifetime are bounded by those two rates. The long-prompt
// rate card applies per request; for summed usage above the threshold
// (`singleRequest` false), the range spans both rate cards.
export function priceClaudeTokens(model: string, input: number, read: number, output: number, write: number,
  lifetimes: WriteLifetimes | null = null, singleRequest = false) {
  const id = claudeModelId(model);
  const short = claudeRates[id];
  if (!short || ![input, read, output, write].every(valid)) return null;
  const long = claudeLongPromptRates[id];
  const overThreshold = long !== undefined && input + read + write > long.threshold;
  const low = overThreshold && singleRequest ? long : short;
  const high = overThreshold ? long : short;
  const split = lifetimes && lifetimes.fiveMinuteTokens + lifetimes.oneHourTokens + lifetimes.unknownTokens === write
    ? lifetimes : { fiveMinuteTokens: 0, oneHourTokens: 0, unknownTokens: write };
  const base = (rate: ClaudeRate) => input * rate.input + read * rate.read + output * rate.output
    + (split.fiveMinuteTokens * 1.25 + split.oneHourTokens * 2) * rate.input;
  return { minUsd: (base(low) + split.unknownTokens * low.input * 1.25) / 1e6,
    maxUsd: (base(high) + split.unknownTokens * high.input * 2) / 1e6,
    readSavingsUsd: read * (low.input - low.read) / 1e6,
    hitRate: input + read + write > 0 ? read / (input + read + write) : null };
}
function estimateClaudeCost(rows: ThreadEventRow[], providerId: string): Calculation {
  const usage = collectTurnUsage(rows, providerId);
  const ordered = [...rows].sort((a, b) => b.seq - a.seq);
  const start = ordered.find(row => row.type === 'turn/started' && row.scope?.kind === 'turn' && row.scope.turnId === usage.turnId);
  const rejected = new Set(ordered.flatMap(row => row.type === 'client/turn/rejected' ? [row.data.requestId] : []));
  const request = start && ordered.find(row => row.seq < start.seq && row.type === 'client/turn/requested' && !rejected.has(row.data.requestId));
  const model = request?.type === 'client/turn/requested' ? request.data.execution.model : null;
  if (!usage.steps.length || !start) return unavailable(usage.note ?? 'Waiting for Claude Code usage.', model, usage.turnId);
  if (providerId !== 'claude-code-telemetry' && ordered.some(row => row.seq > start.seq && row.type === 'provider/modelFallback'))
    return unavailable('Claude model changed during this turn; per-model usage is not exposed by BB.', model, usage.turnId);
  if (!model && providerId !== 'claude-code-telemetry') return unavailable('Claude model selection is unavailable.', null, usage.turnId);
  const { inputTokens: input, outputTokens: output, readTokens: read, writeTokens: write } = usage;
  if (providerId === 'claude-code-telemetry') {
    const models = [...new Set(usage.steps.map(step => step.model).filter((model): model is string => model !== null))];
    const label = models.join(' + ') || model;
    // Usage without a model (aggregate remainder, possibly subagents) is
    // estimated at the turn's only model; mixed models leave it unpriced.
    const unattributed = usage.steps.filter(step => !step.model);
    const fallback = unattributed.length === 0 ? null : models.length === 1 ? models[0]! : models.length === 0 ? model : null;
    if (unattributed.length > 0 && !fallback)
      return unavailable('Telemetry has usage without a model in a turn with several models. Tokens are saved, but a full-turn cost cannot be attributed safely.', label, usage.turnId);
    const prices = usage.steps.map(step => step.inputTokens === null || step.outputTokens === null || step.readTokens === null || step.writeTokens === null
      ? null : priceClaudeTokens(step.model ?? fallback!, step.inputTokens, step.readTokens, step.outputTokens, step.writeTokens, step.writeLifetimes, step.source === 'request'));
    if (prices.some(price => price === null)) return unavailable('Request model rates or token counters are unavailable.', label, usage.turnId);
    const priced = prices.filter((price): price is NonNullable<typeof price> => price !== null);
    return { model: label, turnId: usage.turnId, inputTokens: input, outputTokens: output, pricingDate: PRICING_DATE,
      minUsd: priced.reduce((sum, price) => sum + price.minUsd, 0), maxUsd: priced.reduce((sum, price) => sum + price.maxUsd, 0),
      readSavingsUsd: priced.reduce((sum, price) => sum + price.readSavingsUsd, 0),
      hitRate: input !== null && read !== null && write !== null && input + read + write > 0 ? read / (input + read + write) : null,
      note: 'Claude Code Telemetry: each request uses its reported model and Anthropic Standard API rates. '
        + (usage.steps.every(step => step.writeTokens === 0 || step.writeLifetimes?.unknownTokens === 0)
          ? 'Cache writes use reported lifetimes: 5m at 1.25×, 1h at 2× input.' : 'Writes without a reported lifetime use a 5m–1h range.')
        + ' Excludes tools, Fast mode, regional and long-context surcharges; not subscription billing.'
        + (usage.steps.some(step => step.incomplete) ? ' Incomplete requests include observed tokens only.' : '')
        + (fallback ? ` Estimate: usage without a model (aggregate remainder, may include subagents) is priced at ${fallback} rates.` : ''),
      ...(fallback ? { remainderModel: fallback } : {}) };
  }

  if (input === null || output === null || read === null || write === null)
    return unavailable('Claude Code input, output, cache read or cache write counts are incomplete.', model, usage.turnId);
  const price = priceClaudeTokens(model!, input, read, output, write);
  if (!price) return unavailable('No verified Anthropic API rate for the recorded Claude model.', model, usage.turnId);
  return { ...price, model, turnId: usage.turnId, inputTokens: input, outputTokens: output, pricingDate: PRICING_DATE,
    note: 'Claude Code turn usage. Anthropic Standard API equivalent for the selected model; BB does not expose per-model SDK cost. Not a bill or subscription-limit estimate. Input excludes cache reads/writes, which are priced separately. Excludes tools, Fast mode, regional and long-context surcharges.'
      + (write > 0 ? ' Range uses 5m–1h write rates: the aggregate TTL report cannot separate mixed write lifetimes.' : '')
      + (input + read + write > (claudeLongPromptRates[claudeModelId(model!)]?.threshold ?? Infinity)
        ? ' Range spans both prompt-length rate cards: turn totals cannot show which requests exceeded the threshold.' : '') };
}
export function estimateTurnCost(providerId: string, rows: ThreadEventRow[]): CostEstimate {
  const claude = providerId === 'claude-code' || providerId === 'claude-code-telemetry';
  return { ...(claude ? estimateClaudeCost(rows, providerId) : estimateCodexCost(providerId, rows)), providerId,
    pricingUrl: claude ? CLAUDE_PRICING_URL : PRICING_URL,
    pricingLabel: claude ? 'Anthropic Standard API rates' : 'OpenAI Standard API rates' };
}

export function usd(value: number | null | undefined): string {
  if (value == null) return 'Unavailable';
  if (value > 0 && value < 0.0001) return '<$0.0001';
  return `$${value.toFixed(4)}`;
}
export function costRange(cost: CostEstimate | null | undefined): string {
  if (cost?.minUsd == null || cost.maxUsd == null) return 'Unavailable';
  return Math.abs(cost.maxUsd - cost.minUsd) < 1e-10 ? usd(cost.minUsd) : `${usd(cost.minUsd)}–${usd(cost.maxUsd)}`;
}

/** Compact estimate only; detailed views retain the full range. */
export function compactCost(cost: CostEstimate | null | undefined): string {
  if (cost?.minUsd == null || cost.maxUsd == null) return 'Unavailable';
  return `$${((cost.minUsd + cost.maxUsd) / 2).toFixed(2)}`;
}
