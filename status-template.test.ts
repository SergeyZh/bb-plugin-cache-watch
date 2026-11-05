import { expect, it } from 'vitest';
import { DEFAULT_STATUS_TEMPLATE, STATUS_PRESETS, renderStatusParts, renderStatusTemplate, templateData, validateStatusTemplate } from './status-template';
import type { CacheStatus } from './server';

function status(overrides: Partial<CacheStatus> = {}): CacheStatus {
  return { threadId: 'thr_template123', title: 'Demo', providerId: 'claude-code', status: 'idle',
    estimatedExpiresAt: 3_661_000, expirySource: 'provider', sample: null, watch: null, nextPingAt: null,
    turn: { turnId: 'turn1', firstReadTokens: 0, readTokens: 734800, writeTokens: 10, inputTokens: 100, outputTokens: 20, note: null, steps: [] },
    cost: { providerId: 'claude-code', model: 'claude-opus-5-5', turnId: 'turn1', minUsd: 0.1608, maxUsd: 0.1637,
      readSavingsUsd: 0.12, hitRate: 0.73, inputTokens: 100, outputTokens: 20, note: '', pricingDate: '', pricingUrl: 'https://example.com', pricingLabel: '' },
    ...overrides };
}
it('exposes time components, midpoint cost and a first miss independently of a warm TTL', () => {
  const data = templateData(status(), 0);
  expect(data).toMatchObject({ state: 'warm', hours: 1, minutes: 1, seconds: 1, totalSeconds: 3661,
    firstRequest: 'miss', firstHit: false, cost: 0.16225, readTokens: 734800 });
  expect(renderStatusTemplate('{{hours | pad2}}:{{minutes | pad2}}:{{seconds | pad2}} · {{cost | usd:2}} · {{hitRate | percent:1}}', data)).toBe('01:01:01 · $0.16 · 73.0%');
  expect(renderStatusTemplate('{{costMin | fixed:4}}–{{costMax | fixed:4}}', data)).toBe('0.1608–0.1637');
});
it('preserves unknown values and distinguishes unknown, false and zero in conditions', () => {
  const data = templateData(null, 0);
  expect(data).toMatchObject({ state: 'unknown', hours: null, firstRequest: 'unknown', firstHit: null, cost: null });
  const template = '{{#if firstHit == null}}?{{else}}{{#if firstHit}}✓{{else}}✗{{/if}}{{/if}}';
  expect(renderStatusTemplate(template, data)).toBe('?');
  expect(renderStatusTemplate(template, templateData(status(), 0))).toBe('✗');
  expect(renderStatusTemplate(template, { ...data, firstHit: true })).toBe('✓');
  expect(renderStatusTemplate('{{cost | usd:2}}', data)).toBe('?');
  expect(renderStatusTemplate('{{#if firstReadTokens == 0}}zero{{/if}}', templateData(status(), 0))).toBe('zero');
});
it('marks exact expiry and elapsed estimates as expired and supports empty output', () => {
  for (const now of [3_661_000, 4_000_000]) {
    const data = templateData(status(), now);
    expect(data).toMatchObject({ state: 'expired', hours: 0, minutes: 0, seconds: 0 });
    expect(renderStatusTemplate('{{#if state != "expired"}}show{{/if}}', data)).toBe('');
  }
});
it('keeps the default labels and all presets valid in each state', () => {
  expect(renderStatusTemplate(DEFAULT_STATUS_TEMPLATE, templateData(status(), 0))).toBe('Cache · ~1h 1m 01s left');
  expect(renderStatusTemplate(DEFAULT_STATUS_TEMPLATE, templateData(null, 0))).toBe('Cache · loading…');
  expect(renderStatusTemplate(DEFAULT_STATUS_TEMPLATE, templateData(null, 0, true))).toBe('Cache · unavailable');
  expect(renderStatusTemplate(DEFAULT_STATUS_TEMPLATE, templateData(status({ expirySource: 'codex-assumption' }), 0, true))).toBe('Cache · ~1h 1m 01s left · assumed 30m · stale');
  for (const preset of STATUS_PRESETS) {
    expect(validateStatusTemplate(preset.template)).toBeNull();
    for (const report of [status(), status({ estimatedExpiresAt: 0 }), null]) expect(() => renderStatusTemplate(preset.template, templateData(report, 0))).not.toThrow();
  }
});
it('rejects malformed expressions and never executes code or interpolates output recursively', () => {
  for (const template of ['{{missing}}', '{{seconds | fixed:99}}', '{{#if state}}oops', '{{else}}', '{{/if}}', '{{#if state > 1}}x{{/if}}', '{{constructor}}', '{{globalThis.process.exit()}}', 'text {{state', 'x'.repeat(4097)]) {
    expect(validateStatusTemplate(template)).not.toBeNull();
  }
  const data = { ...templateData(null, 0), model: '{{seconds}} <script>alert(1)</script>' };
  expect(renderStatusTemplate('{{model}}', data)).toBe(data.model);
  expect(validateStatusTemplate('{{#if loading}}'.repeat(17) + '{{/if}}'.repeat(17))).not.toBeNull();
  expect(renderStatusTemplate('x'.repeat(1000), data)).toHaveLength(512);
});

it('renders explicit monospace blocks without changing text or styling following content', () => {
  const data = templateData(status(), 0);
  const template = 'Cache {{#mono}}{{hours | pad2}}:{{minutes | pad2}}:{{seconds | pad2}}{{/mono}} · normal';
  expect(renderStatusParts(template, data)).toEqual([
    { text: 'Cache ', mono: false }, { text: '01:01:01', mono: true }, { text: ' · normal', mono: false },
  ]);
  expect(renderStatusTemplate(template, data)).toBe('Cache 01:01:01 · normal');
  expect(renderStatusParts('{{#mono}}{{#if firstHit}}yes{{else}}no{{/if}}{{/mono}} normal', data)).toEqual([
    { text: 'no', mono: true }, { text: ' normal', mono: false },
  ]);
  expect(renderStatusParts('{{#if firstHit}}{{#mono}}hidden{{/mono}}{{/if}} normal', data)).toEqual([{ text: 'normal', mono: false }]);
  for (const invalid of ['{{#mono}}oops', '{{/mono}}', '{{#if firstHit}}{{#mono}}bad{{/if}}{{/mono}}']) expect(validateStatusTemplate(invalid)).not.toBeNull();
});
it('exposes cache-write lifetimes and the reported cache lifetime', () => {
  const data = templateData(status({ providerId: 'claude-code-telemetry',
    sample: { at: 0, readTokens: 1, writeTokens: 10, inputTokens: 1, ttlMs: 3_600_000 },
    turn: { turnId: 'turn1', firstReadTokens: 0, readTokens: 1, writeTokens: 10, inputTokens: 1, outputTokens: 1, note: null, steps: [],
      writeLifetimes: { fiveMinuteTokens: 3, oneHourTokens: 7, unknownTokens: 0 } } }), 0);
  expect(renderStatusTemplate('{{cacheLifetime}} · 5m {{write5mTokens}} · 1h {{write1hTokens}}', data)).toBe('1h · 5m 3 · 1h 7');
  expect(templateData(status({ sample: { at: 0, readTokens: 1, writeTokens: 1, inputTokens: 1, ttlMs: 300_000 } }), 0))
    .toMatchObject({ cacheLifetime: '5m', write5mTokens: null, write1hTokens: null });
});
it('formats non-minute cache lifetimes in seconds instead of rounding to 0h or 2m', () => {
  for (const [ms, text] of [[20_000, '20s'], [90_000, '90s'], [1_800_000, '30m'], [7_200_000, '2h']] as const)
    expect(templateData(status({ sample: { at: 0, readTokens: 1, writeTokens: 1, inputTokens: 1, ttlMs: ms } }), 0).cacheLifetime).toBe(text);
});
