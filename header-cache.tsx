import { useEffect, useState } from 'react';
import { useRealtime, useRpc, type PluginAppBuilder } from '@get-bb/plugin-sdk/app';
import type { CacheStatus, rpcContract } from './server';
import { cacheIsVisible, ThreadCacheCard, useCacheDisplayThreshold, useCachePlacement } from './thread-cache';
import { DEFAULT_STATUS_TEMPLATE, renderStatusTemplate, templateData } from './status-template';
import { useStatusTemplate } from './template-settings';
import { SessionStatisticsButton } from './statistics-ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';

export function registerCacheHeader(app: PluginAppBuilder) {
  let labels = new Map<string, string>();
  let refreshStyles: (() => void) | null = null;
  // Header action labels are strings: the host does not expose className or
  // React content here. Decorate only our host-rendered label, including its
  // compact/menu form, and release all DOM changes when this generation ends.
  app.contentScripts.register({
    id: 'cache-header-font',
    mount: () => {
      const attribute = 'data-cache-watch-header-font';
      const style = document.createElement('style');
      style.textContent = `[${attribute}] { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-variant-numeric: tabular-nums; }
        [${attribute}][${attribute}="active"] { color: #15803d; }
        [${attribute}][${attribute}="elapsed"] { color: #b91c1c; }
        [${attribute}][${attribute}="unknown"] { color: var(--muted-foreground, #737373); }
        :where(.dark) [${attribute}][${attribute}="active"] { color: #4ade80; }
        :where(.dark) [${attribute}][${attribute}="elapsed"] { color: #f87171; }`;
      document.head.append(style);
      const marked = new Set<HTMLElement>();
      const label = /^Cache · (?:~(?:\d+h )?\d+m \d{2}s left|TTL not reported|Estimated TTL elapsed|unavailable|loading…)(?: · assumed 30m)?(?: · stale)?$/;
      const update = () => {
        for (const element of marked) {
          if (!element.isConnected || (!labels.has(element.textContent?.trim() ?? '') && !label.test(element.textContent?.trim() ?? ''))) {
            element.removeAttribute(attribute);
            marked.delete(element);
          }
        }
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-thread-header-workflow-actions] button, [role="menuitem"]'))) {
          const text = element.textContent?.trim() ?? '';
          if (labels.has(text) || label.test(text)) {
            const state = labels.get(text) ?? (text.startsWith('Cache · ~') ? 'active'
              : text.startsWith('Cache · Estimated TTL elapsed') ? 'elapsed' : 'unknown');
            if (element.getAttribute(attribute) !== state) element.setAttribute(attribute, state);
            marked.add(element);
          }
        }
      };
      const observer = new MutationObserver(update);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      update();
      refreshStyles = update;
      return () => {
        if (refreshStyles === update) refreshStyles = null;
        observer.disconnect();
        for (const element of marked) element.removeAttribute(attribute);
        marked.clear();
        style.remove();
      };
    },
  });
  let openDetails: ((threadId: string) => void) | null = null;
  function HeaderDetails() {
    const [threadId, setThreadId] = useState<string | null>(null);
    useEffect(() => {
      openDetails = setThreadId;
      return () => { if (openDetails === setThreadId) openDetails = null; };
    }, []);
    return <Dialog open={threadId !== null} onOpenChange={open => { if (!open) setThreadId(null); }}>
      <DialogContent className="flex max-h-[80dvh] flex-col overflow-hidden">
        <DialogHeader><DialogTitle>Prompt cache</DialogTitle><DialogDescription>Provider-reported usage and estimated expiry for this session.</DialogDescription></DialogHeader>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {threadId && <ThreadCacheCard key={threadId} threadId={threadId} projectId="" environment={null}
            sessionAction={<SessionStatisticsButton threadId={threadId} />} />}
        </div>
      </DialogContent>
    </Dialog>;
  }
  app.slots.experimental_appOverlay({ id: 'cache-header-details', component: HeaderDetails });
  app.slots.experimental_threadAction({
    id: 'cache-header', title: 'Prompt cache', icon: 'Database', group: 'cache', placement: 'header',
    useData: ({ threadIds }) => {
      const placement = useCachePlacement();
      const threshold = useCacheDisplayThreshold();
      const { template } = useStatusTemplate();
      const rpc = useRpc<typeof rpcContract>();
      const [reports, setReports] = useState<Record<string, CacheStatus>>({});
      const [failed, setFailed] = useState<Set<string>>(new Set());
      const [now, setNow] = useState(Date.now);
      const key = placement === 'header' ? JSON.stringify(threadIds) : '[]';
      const [revision, setRevision] = useState(0);
      useRealtime('changed', () => setRevision(value => value + 1));
      useEffect(() => {
        const ids: string[] = JSON.parse(key);
        let live = true;
        const refresh = async () => {
          const results = await Promise.all(ids.map(async id => {
            try { return { id, status: await rpc.call('status', { threadId: id }) }; }
            catch { return { id, status: null }; }
          }));
          if (!live) return;
          setReports(previous => Object.fromEntries(results.flatMap(({ id, status }) => status || previous[id] ? [[id, status ?? previous[id]]] : [])));
          setFailed(new Set(results.filter(result => !result.status).map(result => result.id)));
        };
        if (!ids.length) return;
        void refresh();
        const poll = setInterval(() => void refresh(), 30_000);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { live = false; clearInterval(poll); clearInterval(tick); };
      }, [rpc, key, revision]);
      const formatted = new Map<string, { label: string; state: string }>();
      for (const id of threadIds) {
        const status = reports[id];
        const data = templateData(status, now, failed.has(id));
        let label: string;
        try { label = renderStatusTemplate(template, data); }
        catch { label = renderStatusTemplate(DEFAULT_STATUS_TEMPLATE, data); }
        formatted.set(id, { label, state: data.state === 'warm' ? 'active' : data.state === 'expired' ? 'elapsed' : 'unknown' });
      }
      useEffect(() => {
        labels = new Map();
        for (const item of formatted.values()) {
          // The host exposes only label text in its DOM. If a constant template
          // gives different panes identical labels, avoid assigning a wrong TTL color.
          const previous = labels.get(item.label);
          labels.set(item.label, previous && previous !== item.state ? 'unknown' : item.state);
        }
        refreshStyles?.();
        return () => { labels.clear(); refreshStyles?.(); };
      }, [template, reports, failed, now, key]);
      return { placement, threshold, reports, failed, now, formatted };
    },
    item: ({ thread, data }) => {
      if (data.placement !== 'header') return null;
      const status = data.reports[thread.id];
      if (!cacheIsVisible(status?.estimatedExpiresAt, data.now, data.threshold)) return null;
      const label = data.formatted.get(thread.id)?.label;
      if (!label) return null;
      return {
        label,
        icon: 'Database', detail: 'Open cache usage, cost details, and keepalive controls',
        run: () => { openDetails?.(thread.id); },
      };
    },
  });
}
