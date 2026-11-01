import { useEffect } from 'react';
import { useRpc, type PluginAppBuilder } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { rpcContract } from './server';

type Action = 'status' | 'start' | 'renew' | 'stop';
const time = (at: number) => new Date(at).toLocaleString();

export function registerKeepaliveCommands(app: PluginAppBuilder) {
  // The host mounts overlays once per client, providing the authenticated,
  // plugin-bound RPC hook to palette handlers without relying on a thread pane.
  let execute: ((action: Action, threadId: string) => Promise<void>) | null = null;
  const pending = new Set<string>();
  function CommandRuntime() {
    const rpc = useRpc<typeof rpcContract>();
    useEffect(() => {
      const run = async (action: Action, threadId: string) => {
        if (pending.has(threadId)) return;
        pending.add(threadId);
        try {
          if (action === 'status') {
            const status = await rpc.call('status', { threadId });
            const watch = status.watch;
            const state = !watch ? 'Off' : watch.disabled ? 'Paused' : watch.until <= Date.now() ? 'Expired' : 'Enabled';
            toast(`Keepalive: ${state}`, {
              description: [status.title,
                ...(watch ? [`Ends: ${time(watch.until)} · ${watch.sent} pings`] : []),
                ...(state === 'Enabled' ? [status.nextPingAt === null ? 'Waiting for fresh expiry telemetry' : `Next ping: ${time(status.nextPingAt)}`] : []),
                ...(watch?.error ? [watch.error] : []),
              ].join('\n'),
              duration: 12_000,
            });
          } else if (action === 'stop') {
            await rpc.call('stop', { threadId });
            toast.success('Keepalive stopped', { description: threadId });
          } else {
            const watch = await rpc.call('start', { threadId, durationHours: 6 });
            toast.success(action === 'renew' ? 'Paid keepalive renewed for 6 hours' : 'Paid keepalive enabled for 6 hours', {
              description: `${threadId} · Ends: ${time(watch.until)}. Pings are paid turns, 5 minutes before estimated expiry.`,
            });
          }
        } catch (error) {
          toast.error('Keepalive command failed', { description: `${threadId}: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          pending.delete(threadId);
        }
      };
      execute = run;
      return () => { if (execute === run) execute = null; };
    }, [rpc]);
    return null;
  }
  app.slots.experimental_appOverlay({ id: 'keepalive-commands', component: CommandRuntime });
  const commands: [Action, string][] = [
    ['status', 'Keepalive: Show status'],
    ['start', 'Keepalive: Enable paid keepalive for 6 hours'],
    ['renew', 'Keepalive: Renew paid keepalive for 6 hours'],
    ['stop', 'Keepalive: Stop keepalive'],
  ];
  for (const [action, title] of commands) {
    app.commands.register({
      id: `keepalive-${action}`, title,
      isAvailable: ({ threadId }) => threadId !== null && execute !== null,
      async run({ threadId }) {
        if (threadId !== null && execute) await execute(action, threadId);
      },
    });
  }
}
