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
