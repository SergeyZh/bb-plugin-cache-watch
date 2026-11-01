import { describe, expect, it } from 'vitest';
import { collectTurnUsage } from './turn-usage';

type Rows = Parameters<typeof collectTurnUsage>[0];
const counts = (input: number, read: number, write: number | undefined = 0, output = 10) => ({
  inputTokens: input, cachedInputTokens: read, outputTokens: output, cacheWriteInputTokens: write,
  totalTokens: input + output, reasoningOutputTokens: 0,
});
function report(seq: number, total: ReturnType<typeof counts> & { cacheReadInputTokens?: number }, last = total, turnId = 't1', session = 's1') {
  return { seq, createdAt: seq * 1000, type: 'thread/tokenUsage/updated', scope: { kind: 'turn', turnId },
    data: { providerThreadId: session, tokenUsage: { total, last } } };
}
const start = (seq = 1, turnId = 't1') => ({ seq, type: 'turn/started', scope: { kind: 'turn', turnId } });
const collect = (rows: unknown[]) => collectTurnUsage(rows as Rows);

describe('whole-turn cache usage', () => {
  it('sums requests while keeping the first miss separate from subsequent hits', () => {
    const result = collect([start(), report(2, counts(100, 0, 50)),
      report(3, counts(300, 150, 70, 20), counts(200, 150, 20)),
      report(4, counts(600, 400, 70, 30), counts(300, 250))]);
    expect(result).toMatchObject({ readTokens: 400, writeTokens: 70, firstReadTokens: 0, note: null });
    expect(result.steps.map(step => [step.readTokens, step.writeTokens, step.combined])).toEqual([
      [0, 50, false], [150, 20, false], [250, 0, false],
    ]);
  });
  it('ignores duplicate notifications, including a stale previous-turn report', () => {
    const previous = counts(100, 50);
    const result = collect([report(1, previous, previous, 'old'), start(2), report(3, previous),
      report(4, counts(300, 150, 0, 20), counts(200, 100)),
      report(5, counts(300, 150, 0, 20), counts(200, 100))]);
    expect(result).toMatchObject({ firstReadTokens: 100, readTokens: 100, writeTokens: 0 });
    expect(result.steps).toHaveLength(1);
  });
  it('waits for a new turn without reusing the previous turn hit', () => {
    expect(collect([start(), report(2, counts(100, 50)), start(3, 't2')])).toMatchObject({
      turnId: 't2', steps: [], readTokens: null, firstReadTokens: null,
    });
  });
  it('keeps missing writes unknown instead of zero', () => {
    // Remove the optional counter explicitly (the fixture defaults to zero).
    const missing = report(2, counts(100, 0));
    delete (missing.data.tokenUsage.total as { cacheWriteInputTokens?: number }).cacheWriteInputTokens;
    expect(collect([start(), missing])).toMatchObject({ writeTokens: null, readTokens: 0, firstReadTokens: 0 });
  });
  it('marks combined first reports and refuses to infer the first individual cache hit', () => {
    expect(collect([report(1, counts(100, 0), undefined, 'old'), start(2),
      report(3, counts(600, 300, 0, 30), counts(300, 250))])).toMatchObject({
      firstReadTokens: null, readTokens: 300, steps: [{ combined: true }],
    });
  });
  it('does not silently claim a complete sum for missing boundaries, resets, or session changes', () => {
    for (const rows of [
      [report(2, counts(100, 50))],
      [start(), report(2, counts(100, 50)), report(3, counts(20, 0))],
      [start(), report(2, counts(100, 50)), report(3, counts(200, 150), undefined, 't1', 'other')],
    ]) expect(collect(rows)).toMatchObject({ readTokens: null, writeTokens: null, firstReadTokens: null });
  });
  it('recognizes distinct uncached requests with identical last counts', () => {
    const result = collect([start(), report(2, counts(100, 0)),
      report(3, counts(200, 0, 0, 20), counts(100, 0))]);
    expect(result.steps).toHaveLength(2);
    expect(result).toMatchObject({ readTokens: 0, firstReadTokens: 0 });
  });
});

it('never substitutes Claude combined cachedInputTokens for cache reads or claims a first-request hit from a turn aggregate', () => {
  const data = [start(), report(2, counts(100, 5000, 5000))] as unknown as Rows;
  const result = collectTurnUsage(data, 'claude-code');
  expect(result).toMatchObject({ readTokens: null, writeTokens: 5000, firstReadTokens: null,
    inputTokens: 100, steps: [{ combined: true }] });
});

it('recognizes request metadata from Claude Code Telemetry and keeps aggregate remainders combined', () => {
  const a = { ...counts(100, 40, 5), cacheReadInputTokens: 40 };
  const b = { ...counts(100, 0, 5), cacheReadInputTokens: 0 };
  const metadata = (seq: number, source: string, last: typeof a) => ({ seq, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
    data: { kind: 'claude-code-telemetry/usage', payload: { source, messageId: source === 'request' ? `msg-${seq}` : null, model: source === 'request' ? 'claude-opus-5-5' : null, incomplete: false, counts: last } } });
  const total = { ...counts(200, 40, 10, 20), cacheReadInputTokens: 40 };
  const data = [start(), metadata(2, 'request', a), report(3, a), metadata(4, 'aggregate-remainder', b),
    report(5, total, b)] as unknown as Rows;
  expect(collectTurnUsage(data, 'claude-code-telemetry')).toMatchObject({
    readTokens: 40, inputTokens: 200, firstReadTokens: 40, steps: [{ combined: false }, { combined: true }],
  });
  expect(collectTurnUsage([start(), report(3, a)] as unknown as Rows, 'claude-code-telemetry').firstReadTokens).toBeNull();
});

const telemetryMeta = (seq: number, last: ReturnType<typeof counts>, source = 'request', incomplete = false, model: string | null = 'claude-opus-5-5') => ({
  seq, type: 'thread/extensionState/updated', scope: { kind: 'thread' },
  data: { kind: 'claude-code-telemetry/usage', payload: { source, incomplete, model,
    messageId: source === 'request' ? `message-${seq}` : null, counts: last } },
});
it('retains request identity/model and preserves a first miss despite subsequent hits and residuals', () => {
  const a = { ...counts(10, 0, 0), cacheReadInputTokens: 0 };
  const b = { ...counts(10, 90, 0), cacheReadInputTokens: 90 };
  const result = collectTurnUsage([start(), telemetryMeta(2, a), report(3, a), telemetryMeta(4, b),
    report(5, { ...counts(20, 90, 0, 20), cacheReadInputTokens: 90 }, b),
    telemetryMeta(6, b, 'aggregate-remainder', true, null),
    report(7, { ...counts(30, 180, 0, 30), cacheReadInputTokens: 180 }, b)] as unknown as Rows, 'claude-code-telemetry');
  expect(result).toMatchObject({ firstReadTokens: 0, readTokens: 180, inputTokens: 30,
    steps: [{ source: 'request', messageId: 'message-2', model: 'claude-opus-5-5', combined: false },
      { source: 'request', messageId: 'message-4', combined: false },
      { source: 'aggregate-remainder', model: null, combined: true, incomplete: true }] });
});
it('keeps incomplete, malformed and mismatched metadata conservative, without reusing a consumed snapshot', () => {
  const a = { ...counts(10, 90, 0), cacheReadInputTokens: 90 };
  for (const metadata of [telemetryMeta(2, a, 'request', true), telemetryMeta(2, counts(123, 0)),
    { ...telemetryMeta(2, a), data: { kind: 'claude-code-telemetry/usage', payload: { source: 'request' } } }]) {
    const turn = collectTurnUsage([start(), metadata, report(3, a)] as unknown as Rows, 'claude-code-telemetry');
    expect(turn).toMatchObject({ firstReadTokens: null, readTokens: 90, steps: [{ combined: true }] });
  }
  const turn = collectTurnUsage([start(), telemetryMeta(2, a), report(3, a), report(4, a),
    report(5, { ...counts(20, 180, 0, 20), cacheReadInputTokens: 180 }, a)] as unknown as Rows, 'claude-code-telemetry');
  expect(turn.steps).toHaveLength(2);
  expect(turn.steps[1]).toMatchObject({ source: 'unattributed', model: null, combined: true });
});
it('does not bind previous-turn metadata to a new turn with identical request counts', () => {
  const a = { ...counts(10, 90, 0), cacheReadInputTokens: 90 };
  const result = collectTurnUsage([start(), telemetryMeta(2, a), start(3, 't2'), report(4, a, a, 't2')] as unknown as Rows, 'claude-code-telemetry');
  expect(result).toMatchObject({ turnId: 't2', firstReadTokens: null, steps: [{ source: 'unattributed', combined: true }] });
});
