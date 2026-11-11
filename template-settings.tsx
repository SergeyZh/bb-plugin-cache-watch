import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import { defaultStatusTemplate, statusPresets, VARIABLES, renderStatusParts, templateData, validateStatusTemplate, type TemplateData, type TemplateSurface } from './status-template';
import { StatusTemplateText } from './status-template-ui';
import { Button } from './components/ui/button';

export function useStatusTemplate(surface: TemplateSurface = 'header') {
  const rpc = useRpc<typeof rpcContract>();
  const [template, setTemplate] = useState(() => defaultStatusTemplate(surface));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const result = await rpc.call('getStatusTemplate', surface === 'header' ? null : { surface });
      if (version !== sequence.current) return;
      setTemplate(result.template); setError('');
    } catch (error) {
      if (version === sequence.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (version === sequence.current) setLoading(false); }
  }, [rpc, surface]);
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, [refresh]);
  useRealtime('template-changed', () => { void refresh(); });
  return { template, loading, error, refresh };
}

function StatusTemplateEditor({ surface }: { surface: TemplateSurface }) {
  const presets = statusPresets(surface);
  const rpc = useRpc<typeof rpcContract>();
  const saved = useStatusTemplate(surface);
  const [draft, setDraft] = useState(() => defaultStatusTemplate(surface));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [scenario, setScenario] = useState('warm');
  // Read through a ref: an edit made right after a save lands before that
  // save's effect runs, and a captured `dirty` would overwrite the edit.
  const edited = useRef(false);
  useEffect(() => { if (!edited.current) setDraft(saved.template); }, [saved.template]);
  const validation = validateStatusTemplate(draft) ?? (!draft.length ? 'Template cannot be empty.' : null);
  const example: TemplateData = {
    ...templateData(null, 0), state: scenario, loading: false, hasUsage: true, hasReport: true, ttlKnown: scenario !== 'unknown',
    hours: scenario === 'unknown' ? null : 0, minutes: scenario === 'warm' ? 4 : scenario === 'expired' ? 0 : null,
    seconds: scenario === 'warm' ? 9 : scenario === 'expired' ? 0 : null, totalSeconds: scenario === 'warm' ? 249 : scenario === 'expired' ? 0 : null,
    ttl: scenario === 'warm' ? '~4m 09s left' : scenario === 'expired' ? 'Estimated TTL elapsed' : 'TTL not reported',
    firstRequest: scenario === 'unknown' ? 'unknown' : scenario === 'warm' ? 'hit' : 'miss',
    firstHit: scenario === 'unknown' ? null : scenario === 'warm', firstReadTokens: scenario === 'unknown' ? null : scenario === 'warm' ? 20000 : 0,
    readTokens: 734800, writeTokens: 12000, write5mTokens: 0, write1hTokens: 12000, cacheLifetime: '1h', inputTokens: 1000000, outputTokens: 2000, requests: 3,
    cost: 0.16225, costMin: 0.1608, costMax: 0.1637, savings: 0.12, hitRate: 0.73,
    provider: 'claude-code', model: 'claude-opus-5-5',
  };
  const preview = validation ? [] : renderStatusParts(draft, example);
  const ttlColor = scenario === 'warm' ? 'text-green-700 dark:text-green-400' : scenario === 'expired' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground';
  function edit(template: string) { edited.current = true; setDraft(template); setDirty(true); setMessage(''); setFailure(''); }
  async function save() {
    setBusy(true); setFailure(''); setMessage('');
    try {
      await rpc.call('setStatusTemplate', { template: draft, surface });
      edited.current = false;
      await saved.refresh(); setDirty(false); setMessage('Template saved.');
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <fieldset className="min-w-0 space-y-3 rounded-lg border p-3">
    <legend className="px-1 font-medium">{surface === 'header' ? 'Thread header' : 'Thread context'}</legend>
    <div className="flex flex-wrap items-center gap-2">
      <label>Preset <select aria-label="Status template preset" disabled={busy || saved.loading} value={presets.find(preset => preset.template === draft)?.name ?? ''} onChange={event => {
        const preset = presets.find(preset => preset.name === event.target.value);
        if (preset) edit(preset.template);
      }} className="rounded border bg-background p-1">
        <option value="" disabled>Custom</option>{presets.map(preset => <option key={preset.name}>{preset.name}</option>)}
      </select></label>
    </div>
    <label className="block space-y-1">Status template<textarea aria-label="Status template" rows={5} maxLength={4096} disabled={busy || saved.loading} value={draft} onChange={event => edit(event.target.value)} className="block w-full rounded border bg-background p-2 font-mono text-xs" /></label>
    <div className="space-y-2 rounded border p-3">
      <label>Preview <select aria-label="Preview cache state" value={scenario} onChange={event => setScenario(event.target.value)} className="rounded border bg-background p-1">
        <option>warm</option><option>expired</option><option>unknown</option>
      </select></label>
      <p aria-label="Status preview" className={`break-words ${surface === 'header' ? `font-mono ${ttlColor}` : 'text-muted-foreground'}`}>{preview.length ? <StatusTemplateText parts={preview} monoClassName={ttlColor} /> : (validation ? 'Invalid template' : '(status hidden)')}</p>
    </div>
    {(validation || failure || saved.error) && <p role="alert" className="text-destructive">{validation || failure || saved.error}</p>}
    {saved.error && <Button variant="outline" onClick={() => void saved.refresh()}>Retry loading template</Button>}
    <Button disabled={busy || saved.loading || !!saved.error || !!validation || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</Button>
    {message && <p role="status">{message}</p>}
  </fieldset>;
}

export function StatusTemplateSettings() {
  return <div className="space-y-4 text-sm">
    <p className="text-muted-foreground">Header and context row have separate templates. Select the Default preset to restore the original text, then Save template.</p>
    <StatusTemplateEditor surface="header" />
    <StatusTemplateEditor surface="context" />
    <details><summary className="cursor-pointer font-medium">Template syntax and variables</summary>
      <div className="space-y-2 break-words pt-2 text-xs [overflow-wrap:anywhere]">
        <p>Insert a value with <code>{'{{seconds}}'}</code>. Missing values print <code>?</code>. Numbers use a decimal point.</p>
        <p>Monospace: <code>{'{{#mono}}{{minutes | pad2}}:{{seconds | pad2}}{{/mono}}'}</code>. In the context row only this block uses a monospace font and TTL color; text after <code>{'{{/mono}}'}</code> returns to the normal font. Header text remains monospace.</p>
        <p>Filters: <code>{'{{seconds | pad2}}'}</code>, <code>{'{{readTokens | compact}}'}</code>, <code>{'{{cost | usd:2}}'}</code>, <code>{'{{costMin | fixed:4}}'}</code>, <code>{'{{hitRate | percent:1}}'}</code>. Decimal precision supports 0–6 digits.</p>
        <p>Conditions: <code>{'{{#if firstRequest == "hit"}}HIT{{else}}MISS or unknown{{/if}}'}</code>. Use <code>==</code> or <code>!=</code> with strings, numbers, true, false, or null. Plain <code>{'{{#if firstHit}}'}</code> tests truthiness: null, false, 0 and empty text are false. Conditions can nest; else is optional.</p>
        <p>Example: <code>{'{{#if firstHit == null}}?{{else}}{{#if firstHit}}✓{{else}}✗{{/if}}{{/if}}'}</code>. Empty output hides the button. Templates are plain text, up to 4096 characters; output is limited to 512 characters.</p>
        <p>Token counts and cost estimates cover the latest turn, not the whole session. Cost values are API equivalents, not billed amounts. Cache state and button color use the estimated TTL, independently of whether the first request hit the cache.</p>
        <dl className="grid grid-cols-[max-content_auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">{Object.entries(VARIABLES).map(([name, description]) => <div key={name} className="contents"><dt className="font-mono font-medium">{name}</dt><span aria-hidden="true">-</span><dd className="min-w-0 text-muted-foreground">{description}</dd></div>)}</dl>
      </div>
    </details>
  </div>;
}
