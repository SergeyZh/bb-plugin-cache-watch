import type { CacheStatus } from './server';

type Value = string | number | boolean | null;
export const VARIABLES = {
  state: 'TTL estimate: warm, expired, or unknown (not a live cache check).',
  hours: 'Remaining whole hours, or null when TTL is unknown.',
  minutes: 'Remaining minutes within the hour (0–59), or null.',
  seconds: 'Remaining seconds within the minute (0–59), or null.',
  totalSeconds: 'Total remaining seconds, rounded up; 0 after expiry, null if unknown.',
  ttlKnown: 'Boolean: expiry estimate is available.',
  ttl: 'Formatted countdown or an explanation when unknown/expired.',
  firstRequest: 'First request in the latest turn: hit, miss, or unknown.',
  firstHit: 'true for a cache hit, false for a miss, null when unreported.',
  firstReadTokens: 'Cache tokens read on the first request, or null.',
  readTokens: 'Cache tokens read over the latest turn, or null.',
  writeTokens: 'Cache tokens written over the latest turn, or null.',
  write5mTokens: 'Turn cache tokens written with a 5-minute lifetime, or null when lifetimes are unreported.',
  write1hTokens: 'Turn cache tokens written with a 1-hour lifetime, or null when lifetimes are unreported.',
  cacheLifetime: 'Provider-reported cache lifetime of the latest report (5m, 1h, or e.g. 30m), or null.',
  inputTokens: 'Provider-reported turn input tokens, or null. Claude excludes cache reads/writes.',
  outputTokens: 'Turn output tokens, or null.',
  requests: 'Number of usage reports in the turn; a report may combine requests.',
  cost: 'Midpoint of the estimated turn cost range, in USD, or null.',
  costMin: 'Lower bound of the estimated turn cost in USD, or null.',
  costMax: 'Upper bound of the estimated turn cost in USD, or null.',
  savings: 'Estimated cache read savings in USD, or null.',
  hitRate: 'Turn input cache hit ratio (0–1), or null.',
  provider: 'Provider ID.', model: 'Model name, or an empty string.',
  assumed: 'Boolean: TTL uses the Codex 30-minute assumption.',
  keepalive: 'Boolean: paid keepalive is enabled and has not ended.',
  stale: 'Boolean: refreshing telemetry failed.',
  hasUsage: 'Boolean: the latest turn has usage reports.',
  hasReport: 'Boolean: a cache telemetry sample is available.',
  loading: 'Boolean: waiting for the initial status report.',
  unavailable: 'Boolean: no report is available after a refresh failure.',
} as const;
export type TemplateData = Record<keyof typeof VARIABLES, Value>;
export const DEFAULT_STATUS_TEMPLATE = 'Cache · {{#if loading}}loading…{{else}}{{#if unavailable}}unavailable{{else}}{{ttl}}{{/if}}{{/if}}{{#if assumed}} · assumed 30m{{/if}}{{#if stale}} · stale{{/if}}';
export type TemplateSurface = 'header' | 'context';
export const LEGACY_CONTEXT_TEMPLATE = '{{#if hasUsage}}Cache: {{readTokens | compact}} read · {{writeTokens | compact}} written{{else}}{{#if unavailable}}Cache unavailable{{else}}{{#if loading}}Loading cache…{{else}}Cache: waiting for turn usage{{/if}}{{/if}}{{/if}}{{#if hasReport}} · {{ttl}}{{#if assumed}} · assumed 30m{{/if}}{{#if stale}} · stale{{/if}}{{/if}}';
export const DEFAULT_CONTEXT_TEMPLATE = LEGACY_CONTEXT_TEMPLATE.replace('{{ttl}}{{#if assumed}} · assumed 30m{{/if}}', '{{#mono}}{{ttl}}{{#if assumed}} · assumed 30m{{/if}}{{/mono}}');
export function defaultStatusTemplate(surface: TemplateSurface) {
  return surface === 'context' ? DEFAULT_CONTEXT_TEMPLATE : DEFAULT_STATUS_TEMPLATE;
}
export function statusPresets(surface: TemplateSurface) {
  return STATUS_PRESETS.map(preset => {
    if (preset.name === 'Default') return { ...preset, template: defaultStatusTemplate(surface) };
    if (surface === 'header') return preset;
    const template = preset.template
      .replace('{{hours | pad2}}:{{minutes | pad2}}:{{seconds | pad2}}', '{{#mono}}{{hours | pad2}}:{{minutes | pad2}}:{{seconds | pad2}}{{/mono}}')
      .replace('{{minutes | pad2}}m {{seconds | pad2}}s', '{{#mono}}{{minutes | pad2}}m {{seconds | pad2}}s{{/mono}}')
      .replace('{{ttl}}', '{{#mono}}{{ttl}}{{/mono}}');
    return { ...preset, template };
  });
}
export const STATUS_PRESETS = [
  { name: 'Default', template: DEFAULT_STATUS_TEMPLATE },
  { name: 'Clock', template: 'Cache · {{state}}{{#if ttlKnown}} · {{hours | pad2}}:{{minutes | pad2}}:{{seconds | pad2}}{{/if}}' },
  { name: 'Cache hit and cost', template: '{{state}} · {{#if firstRequest == "hit"}}HIT{{else}}{{#if firstRequest == "miss"}}MISS{{else}}?{{/if}}{{/if}} · {{readTokens | compact}} read · {{cost | usd:2}}' },
  { name: 'Detailed', template: 'Cache · {{ttl}} · first: {{firstRequest}} · {{readTokens | compact}} read / {{writeTokens | compact}} written · ~{{cost | usd:2}}' },
  { name: 'Minimal', template: '{{#if state == "warm"}}{{minutes | pad2}}m {{seconds | pad2}}s{{else}}{{state}}{{/if}}' },
] as const;

function lifetime(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms % 60_000 !== 0) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function templateData(status: CacheStatus | null | undefined, now: number, error = false): TemplateData {
  const expiry = status?.estimatedExpiresAt;
  const known = expiry != null && Number.isFinite(expiry);
  const total = known ? Math.max(0, Math.ceil((expiry - now) / 1000)) : null;
  const hours = total === null ? null : Math.floor(total / 3600);
  const minutes = total === null ? null : Math.floor(total % 3600 / 60);
  const seconds = total === null ? null : total % 60;
  const state = !known ? 'unknown' : expiry > now ? 'warm' : 'expired';
  const first = status?.turn?.firstReadTokens;
  const firstRequest = first == null || !Number.isFinite(first) || first < 0 ? 'unknown' : first > 0 ? 'hit' : 'miss';
  const cost = status?.cost;
  const watch = status?.watch;
  return {
    state, hours, minutes, seconds, totalSeconds: total, ttlKnown: known,
    ttl: state === 'unknown' ? 'TTL not reported' : state === 'expired' ? 'Estimated TTL elapsed'
      : `~${hours ? `${hours}h ` : ''}${minutes}m ${String(seconds).padStart(2, '0')}s left`,
    firstRequest, firstHit: firstRequest === 'unknown' ? null : firstRequest === 'hit',
    firstReadTokens: first ?? null, readTokens: status?.turn?.readTokens ?? null,
    writeTokens: status?.turn?.writeTokens ?? null,
    write5mTokens: status?.turn?.writeLifetimes?.fiveMinuteTokens ?? null,
    write1hTokens: status?.turn?.writeLifetimes?.oneHourTokens ?? null,
    cacheLifetime: lifetime(status?.sample?.ttlMs), inputTokens: status?.turn?.inputTokens ?? null,
    outputTokens: status?.turn?.outputTokens ?? null, requests: status?.turn?.steps.length ?? 0,
    cost: cost?.minUsd == null || cost.maxUsd == null ? null : (cost.minUsd + cost.maxUsd) / 2,
    costMin: cost?.minUsd ?? null, costMax: cost?.maxUsd ?? null, savings: cost?.readSavingsUsd ?? null,
    hitRate: cost?.hitRate ?? null, provider: status?.providerId ?? '', model: cost?.model ?? '',
    assumed: status?.expirySource === 'codex-assumption',
    keepalive: !!watch && !watch.disabled && watch.until > now,
    hasUsage: !!status?.turn?.steps.length, hasReport: !!status?.sample,
    stale: error && !!status, loading: !status && !error, unavailable: !status && error,
  };
}

type Node = { kind: 'text'; text: string } | { kind: 'value'; name: keyof TemplateData; filter?: string }
  | { kind: 'mono'; children: Node[] }
  | { kind: 'if'; name: keyof TemplateData; operator?: string; value?: Value; yes: Node[]; no: Node[] };
function variable(value: string): keyof TemplateData {
  if (!Object.hasOwn(VARIABLES, value)) throw new Error(`Unknown variable: ${value}`);
  return value as keyof TemplateData;
}
function parse(template: string): Node[] {
  if (template.length > 4096) throw new Error('Template must be at most 4096 characters.');
  const parts = template.split(/({{[\s\S]*?}})/);
  let position = 0;
  function block(depth: number): { nodes: Node[]; end?: string } {
    if (depth > 16) throw new Error('At most 16 nested conditions are supported.');
    const nodes: Node[] = [];
    while (position < parts.length) {
      const part = parts[position++]!;
      if (!part.startsWith('{{')) {
        if (part.includes('{{') || part.includes('}}')) throw new Error('Unclosed template tag.');
        nodes.push({ kind: 'text', text: part }); continue;
      }
      const tag = part.slice(2, -2).trim();
      if (tag === 'else' || tag === '/if' || tag === '/mono') return { nodes, end: tag };
      if (tag === '#mono') {
        const children = block(depth + 1);
        if (children.end !== '/mono') throw new Error('Missing {{/mono}}.');
        nodes.push({ kind: 'mono', children: children.nodes });
      } else if (tag.startsWith('#if ')) {
        const match = /^#if\s+(\w+)(?:\s*(==|!=)\s*("[^"\n]*"|'[^'\n]*'|true|false|null|-?\d+(?:\.\d+)?))?$/.exec(tag);
        if (!match) throw new Error('Use {{#if variable}} or {{#if variable == "value"}}.');
        const name = variable(match[1]!);
        const literal = match[3];
        const value: Value | undefined = literal === undefined ? undefined : /^['"]/.test(literal) ? literal.slice(1, -1) : JSON.parse(literal);
        const yes = block(depth + 1);
        const no = yes.end === 'else' ? block(depth + 1) : undefined;
        if ((no ?? yes).end !== '/if') throw new Error('Missing {{/if}}.');
        nodes.push({ kind: 'if', name, operator: match[2], value, yes: yes.nodes, no: no?.nodes ?? [] });
      } else {
        const match = /^(\w+)(?:\s*\|\s*(pad2|compact|fixed:[0-6]|usd:[0-6]|percent:[0-6]))?$/.exec(tag);
        if (!match) throw new Error(`Invalid variable or filter: ${tag}`);
        nodes.push({ kind: 'value', name: variable(match[1]!), filter: match[2] });
      }
    }
    return { nodes };
  }
  const result = block(0);
  if (result.end) throw new Error(`Unexpected {{${result.end}}}.`);
  return result.nodes;
}
export function validateStatusTemplate(template: string): string | null {
  try { parse(template); return null; } catch (error) { return (error as Error).message; }
}
function format(value: Value, filter?: string): string {
  if (value === null) return '?';
  if (!filter) return String(value);
  if (filter === 'pad2') return String(value).padStart(2, '0');
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  if (filter === 'compact') return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const [kind, digits] = filter.split(':');
  const number = (kind === 'percent' ? value * 100 : value).toFixed(Number(digits));
  return kind === 'usd' ? `$${number}` : kind === 'percent' ? `${number}%` : number;
}
export type StatusTextPart = { text: string; mono: boolean };
export function renderStatusParts(template: string, data: TemplateData): StatusTextPart[] {
  const raw: StatusTextPart[] = [];
  function render(nodes: Node[], mono = false) {
    for (const node of nodes) {
      if (node.kind === 'text') raw.push({ text: node.text, mono });
      else if (node.kind === 'value') raw.push({ text: format(data[node.name], node.filter), mono });
      else if (node.kind === 'mono') render(node.children, true);
      else {
        const value = data[node.name];
        const yes = node.operator === '==' ? value === node.value : node.operator === '!=' ? value !== node.value : !!value;
        render(yes ? node.yes : node.no, mono);
      }
    }
  }
  render(parse(template));
  // Normalize whitespace and cap the visible output across style boundaries.
  const parts: StatusTextPart[] = [];
  let length = 0;
  let space: boolean | null = null;
  function append(text: string, mono: boolean) {
    const last = parts[parts.length - 1];
    if (last?.mono === mono) last.text += text;
    else parts.push({ text, mono });
    length += text.length;
  }
  outer: for (const part of raw) {
    for (const character of part.text) {
      if (/\s/.test(character)) { if (length) space = part.mono; continue; }
      if (space !== null) { append(' ', space); space = null; }
      if (length >= 512) break outer;
      append(character, part.mono);
      if (length >= 512) break outer;
    }
  }
  return parts;
}
export function renderStatusTemplate(template: string, data: TemplateData): string {
  return renderStatusParts(template, data).map(part => part.text).join('');
}
