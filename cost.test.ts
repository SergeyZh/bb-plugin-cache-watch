import { describe, expect, it } from 'vitest';
import { costRange, estimateTurnCost, priceTokens, usd } from './cost';

type Rows = Parameters<typeof estimateTurnCost>[1];
function usage(seq: number, input: number, read: number, output: number, write: number | undefined = 0, turnId = 'turn2', lastInput = input) {
  return { seq, scope: { kind: 'turn', turnId }, type: 'thread/tokenUsage/updated', data: { providerThreadId: 'session1', tokenUsage: {
    total: { inputTokens: input, cachedInputTokens: read, outputTokens: output, cacheWriteInputTokens: write },
    last: { inputTokens: lastInput, cachedInputTokens: read, outputTokens: output, cacheWriteInputTokens: write },
  } } };
}
function history(model = 'gpt-6.1-sol') {
  return [
    usage(1, 1000, 500, 100, 0, 'turn1'),
    { seq: 2, type: 'client/turn/requested', data: { requestId: 'r2', execution: { model } } },
    { seq: 3, type: 'turn/started', scope: { kind: 'turn', turnId: 'turn2' } },
    usage(4, 11000, 8500, 1100),
    usage(5, 21000, 18500, 2100),
    usage(6, 21000, 18500, 2100), // repeated notification
  ] as unknown as Rows;
}

describe('Standard API cost reference', () => {
  it('charges cached input once and treats output as already including reasoning', () => {
    expect(priceTokens('gpt-6.1-sol', 1e6, 800000, 100000, 0)).toEqual({
      minUsd: 1.48, maxUsd: 1.48, readSavingsUsd: 1.52, hitRate: 0.8,
    });
  });
  it('bounds unknown cache-write lifetimes and missing write counts', () => {
    expect(priceTokens('gpt-6.1-sol', 1e6, 800000, 0, 200000)).toMatchObject({ minUsd: 0.58, maxUsd: 1.08 });
    expect(priceTokens('gpt-6.1-sol', 1e6, 800000, 0, null)).toMatchObject({ minUsd: 0.48, maxUsd: 1.08 });
    expect(priceTokens('gpt-6.1-sol', 0, 0, 0, 0)).toMatchObject({ minUsd: 0, maxUsd: 0, hitRate: null });
  });
  it('rejects unknown models, negative/missing counts, and cache double counting', () => {
    expect(priceTokens('unknown', 1e6, 0, 0, 0)).toBeNull();
    for (const input of [-1, NaN, Infinity]) expect(priceTokens('gpt-6.1-sol', input, 0, 0, 0)).toBeNull();
    expect(priceTokens('gpt-6.1-sol', 100, 90, 0, 20)).toBeNull();
  });
  it('uses cumulative deltas for the full latest turn, deduplicating reports', () => {
    const cost = estimateTurnCost('codex', history());
    expect(cost).toMatchObject({ model: 'gpt-6.1-sol', turnId: 'turn2', inputTokens: 20000,
      outputTokens: 2000, minUsd: 0.0258, maxUsd: 0.0258, readSavingsUsd: 0.0342, hitRate: 0.9 });
    expect(estimateTurnCost('central-codex', history())).toEqual({ ...cost, providerId: 'central-codex' });
  });
  it('uses the first report delta when a new thread has no prior report', () => {
    expect(estimateTurnCost('codex', history().slice(1))).toMatchObject({ inputTokens: 21000, outputTokens: 2100 });
  });
  it('does not apply a new model selection to old reports', () => {
    const rows = history();
    rows.push({ seq: 7, type: 'client/turn/requested', data: { requestId: 'r3', execution: { model: 'gpt-6-astra' } } } as unknown as Rows[number]);
    expect(estimateTurnCost('codex', rows).model).toBe('gpt-6.1-sol');
  });
  it('keeps unavailable data distinct from zero', () => {
    expect(estimateTurnCost('claude-code', history()).minUsd).toBeNull();
    expect(estimateTurnCost('codex', []).minUsd).toBeNull();
    expect(estimateTurnCost('codex', history('unknown')).minUsd).toBeNull();
    expect(estimateTurnCost('codex', history().filter(r => r.type !== 'turn/started')).minUsd).toBeNull();
    const missingOutput = history();
    const row = missingOutput[4];
    if (row.type === 'thread/tokenUsage/updated') row.data.tokenUsage.total.outputTokens = NaN;
    expect(estimateTurnCost('codex', missingOutput).minUsd).toBeNull();
  });
  it('refuses resets, interleaved turns, provider restarts, and mid-turn fallbacks', () => {
    for (const extra of [usage(4.5, 100, 0, 0), usage(4.5, 12000, 9000, 1200, 0, 'other'),
      { seq: 4.5, type: 'provider/modelFallback' }]) {
      const rows = history();
      rows.push(extra as unknown as Rows[number]);
      expect(estimateTurnCost('codex', rows).minUsd).toBeNull();
    }
    const rows = history();
    if (rows[0].type === 'thread/tokenUsage/updated') rows[0].data.providerThreadId = 'oldSession';
    expect(estimateTurnCost('codex', rows).minUsd).toBeNull();
  });
  it('formats zero, small positive amounts, and missing estimates distinctly', () => {
    expect(usd(0)).toBe('$0.0000');
    expect(usd(0.000001)).toBe('<$0.0001');
    expect(costRange(null)).toBe('Unavailable');
    expect(costRange(estimateTurnCost('codex', history()))).toBe('$0.0258');
  });
});

it('does not carry the previous turn cost into a new turn awaiting usage', () => {
  const rows = history();
  rows.push({ seq: 7, type: 'turn/started', scope: { kind: 'turn', turnId: 'turn3' } } as unknown as Rows[number]);
  expect(estimateTurnCost('codex', rows)).toMatchObject({ turnId: 'turn3', minUsd: null });
});

it('prices Claude uncached input, output, reads and writes as separate categories', async () => {
  const { priceClaudeTokens } = await import('./cost');
  const cost = priceClaudeTokens('claude-opus-5-5', 100, 50000, 1000, 10000)!;
  expect(cost.minUsd).toBeCloseTo(0.0804);
  expect(cost.maxUsd).toBeCloseTo(0.1104);
  expect(cost.readSavingsUsd).toBeCloseTo(0.19);
  expect(cost.hitRate).toBeCloseTo(50000 / 60100);
  expect(priceClaudeTokens('claude-sonnet-4-5-20250929', 100, 50000, 1000, 10000)?.minUsd).toBeCloseTo(0.0678);
  expect(priceClaudeTokens('opus', 100, 50000, 1000, 10000)).toBeNull();
});

it('prices Claude Fable models, including the cheaper Fable 5.1 cache reads', async () => {
  const { priceClaudeTokens } = await import('./cost');
  const fable51 = priceClaudeTokens('claude-fable-5-1', 100, 50000, 1000, 10000)!;
  expect(fable51.minUsd).toBeCloseTo(0.1885);
  expect(fable51.maxUsd).toBeCloseTo(0.2635);
  expect(fable51.readSavingsUsd).toBeCloseTo(0.4875);
  expect(priceClaudeTokens('claude-fable-5-1[1m]', 100, 50000, 1000, 10000)).toEqual(fable51);
  expect(priceClaudeTokens('claude-fable-5', 100, 50000, 1000, 10000)?.minUsd).toBeCloseTo(0.226);
});

it('prices Claude Haiku 5.5 with a long-prompt rate card above 100K prompt tokens', async () => {
  const { priceClaudeTokens } = await import('./cost');
  // 60,100 prompt tokens: short rate card whether or not usage is per request.
  expect(priceClaudeTokens('claude-haiku-5-5', 100, 50000, 1000, 10000)).toMatchObject({ minUsd: 0.00226, maxUsd: 0.00301 });
  expect(priceClaudeTokens('claude-haiku-5-5', 100, 50000, 1000, 10000, null, true)).toMatchObject({ minUsd: 0.00226, maxUsd: 0.00301 });
  // 160,100 prompt tokens in one request: long rate card.
  const long = priceClaudeTokens('claude-haiku-5-5', 100, 150000, 1000, 10000, null, true)!;
  expect(long.minUsd).toBeCloseTo(0.0163);
  expect(long.maxUsd).toBeCloseTo(0.02005);
  // Summed usage above the threshold may mix both cards.
  const summed = priceClaudeTokens('claude-haiku-5-5', 100, 150000, 1000, 10000)!;
  expect(summed.minUsd).toBeCloseTo(0.00326);
  expect(summed.maxUsd).toBeCloseTo(0.02005);
});

it('keeps Claude pricing/source distinct from Codex and preserves unknown model rates', () => {
  const rows = history('claude-opus-5-5');
  for (const row of rows) if (row.type === 'thread/tokenUsage/updated') {
    for (const counts of [row.data.tokenUsage.last, row.data.tokenUsage.total]) {
      counts.cacheReadInputTokens = counts.cachedInputTokens;
      counts.cachedInputTokens += counts.cacheWriteInputTokens ?? 0;
    }
  }
  expect(estimateTurnCost('claude-code', rows)).toMatchObject({ providerId: 'claude-code', model: 'claude-opus-5-5', pricingLabel: 'Anthropic Standard API rates' });
  const unknown = estimateTurnCost('claude-code', history('unknown-model'));
  expect(unknown.pricingUrl).toContain('platform.claude.com');
  expect(unknown.minUsd).toBeNull();
  expect(unknown.note).not.toContain('Codex');
});

it('prices telemetry requests by their actual model and leaves unattributed residual cost unavailable', () => {
  const counts = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 110, reasoningOutputTokens: 0 };
  const meta = (seq: number, model: string | null, source = 'request') => ({ seq, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
    data: { kind: 'claude-code-telemetry/usage', payload: { source, messageId: source === 'request' ? `msg${seq}` : null, model, counts, incomplete: source !== 'request' } } });
  const report = (seq: number, multiplier: number) => ({ seq, type: 'thread/tokenUsage/updated', createdAt: 1000,
    scope: { kind: 'turn', turnId: 't1' }, data: { providerThreadId: 'session1', tokenUsage: { last: counts,
      total: { ...counts, inputTokens: 100 * multiplier, outputTokens: 10 * multiplier, totalTokens: 110 * multiplier } } } });
  const rows = [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', execution: { model: 'opus' } } },
    { seq: 2, type: 'turn/started', scope: { kind: 'turn', turnId: 't1' } },
    meta(3, 'claude-opus-5-5'), report(4, 1), meta(5, 'claude-sonnet-5-5'), report(6, 2)] as unknown as Rows;
  const cost = estimateTurnCost('claude-code-telemetry', rows);
  expect(cost.model).toBe('claude-opus-5-5 + claude-sonnet-5-5');
  expect(cost.minUsd).toBeCloseTo(0.0009);
  expect(cost.maxUsd).toBeCloseTo(0.0009);
  rows.push(meta(7, null, 'aggregate-remainder') as unknown as Rows[number], report(8, 3) as unknown as Rows[number]);
  expect(estimateTurnCost('claude-code-telemetry', rows)).toMatchObject({ minUsd: null, maxUsd: null });
});

it('prices Claude cache writes by reported lifetime and bounds only writes without one', async () => {
  const { priceClaudeTokens } = await import('./cost');
  const exact = priceClaudeTokens('claude-opus-5-5', 100, 50000, 1000, 10000, { fiveMinuteTokens: 4000, oneHourTokens: 6000, unknownTokens: 0 })!;
  expect(exact.minUsd).toBeCloseTo(0.0984);
  expect(exact.maxUsd).toBeCloseTo(0.0984);
  const partial = priceClaudeTokens('claude-opus-5-5', 100, 50000, 1000, 10000, { fiveMinuteTokens: 2000, oneHourTokens: 6000, unknownTokens: 2000 })!;
  expect(partial.minUsd).toBeCloseTo(0.0984);
  expect(partial.maxUsd).toBeCloseTo(0.1044);
  // A breakdown that does not sum to the write count falls back to the full range.
  expect(priceClaudeTokens('claude-opus-5-5', 100, 50000, 1000, 10000, { fiveMinuteTokens: 1, oneHourTokens: 0, unknownTokens: 0 }))
    .toEqual(priceClaudeTokens('claude-opus-5-5', 100, 50000, 1000, 10000));
});

it('uses telemetry write lifetimes for an exact Claude Code Telemetry turn estimate', () => {
  const counts = { inputTokens: 100, outputTokens: 1000, cachedInputTokens: 60000, cacheReadInputTokens: 50000, cacheWriteInputTokens: 10000, totalTokens: 61100, reasoningOutputTokens: 0 };
  const rows = [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', execution: { model: 'claude-opus-5-5' } } },
    { seq: 2, type: 'turn/started', scope: { kind: 'turn', turnId: 't1' } },
    { seq: 3, type: 'thread/extensionState/updated', scope: { kind: 'thread' }, data: { kind: 'claude-code-telemetry/usage', payload: {
      source: 'request', messageId: 'msg3', model: 'claude-opus-5-5', incomplete: false, counts,
      cacheWriteBreakdown: { fiveMinuteTokens: 0, oneHourTokens: 10000, unknownTokens: 0 } } } },
    { seq: 4, type: 'thread/tokenUsage/updated', createdAt: 1000, scope: { kind: 'turn', turnId: 't1' },
      data: { providerThreadId: 'session1', tokenUsage: { last: counts, total: counts } } }] as unknown as Rows;
  const cost = estimateTurnCost('claude-code-telemetry', rows);
  expect(cost.minUsd).toBeCloseTo(0.1104);
  expect(cost.maxUsd).toBeCloseTo(0.1104);
  expect(cost.note).toContain('reported lifetimes');
});

it('estimates usage without a model at the turn\'s only model and marks it', () => {
  const counts = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 110, reasoningOutputTokens: 0 };
  const remainder = { ...counts, inputTokens: 0, outputTokens: 155, totalTokens: 155 };
  const meta = (seq: number, model: string | null, last: typeof counts) => ({ seq, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
    data: { kind: 'claude-code-telemetry/usage', payload: { source: model ? 'request' : 'aggregate-remainder', messageId: model ? `msg${seq}` : null, model, counts: last, incomplete: !model } } });
  const report = (seq: number, last: typeof counts, total: typeof counts) => ({ seq, type: 'thread/tokenUsage/updated', createdAt: 1000,
    scope: { kind: 'turn', turnId: 't1' }, data: { providerThreadId: 'session1', tokenUsage: { last, total } } });
  const rows = [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', execution: { model: 'claude-sonnet-5-5' } } },
    { seq: 2, type: 'turn/started', scope: { kind: 'turn', turnId: 't1' } },
    meta(3, 'claude-sonnet-5-5', counts), report(4, counts, counts),
    meta(5, null, remainder), report(6, remainder, { ...counts, outputTokens: 165 })] as unknown as Rows;
  const cost = estimateTurnCost('claude-code-telemetry', rows);
  // Sonnet 5.5: 100 × $2 + (10 + 155) × $10 per MTok.
  expect(cost).toMatchObject({ remainderModel: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5' });
  expect(cost.minUsd).toBeCloseTo(0.00185);
  expect(cost.note).toContain('priced at claude-sonnet-5-5 rates');
});
