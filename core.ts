import { z } from 'zod';

export const PING = '[Cache Watch keepalive] This turn only refreshes the prompt cache. Reply exactly: OK. Do not use tools, edit files, resume tasks, create goals, or perform any other action.';
export const watchInput = z.object({
  threadId: z.string().regex(/^thr_[a-z0-9]+$/),
  durationHours: z.number().min(0.25).max(24).default(6),
}).strict();
export const watchSchema = watchInput.omit({ durationHours: true }).extend({
  armedAt: z.number(), until: z.number(), lastAttemptAt: z.number().nullable(),
  sent: z.number().int().nonnegative(), error: z.string().nullable(),
  disabled: z.boolean(),
});
export type Watch = z.infer<typeof watchSchema>;
export const sampleSchema = z.object({
  at: z.number(), readTokens: z.number(), writeTokens: z.number().nullable(),
  inputTokens: z.number(), ttlMs: z.number().nullable(),
});
export type Sample = z.infer<typeof sampleSchema>;
// One attempt per estimated expiry. Fresh telemetry must move the deadline
// before another paid turn can be scheduled (including after a restart).
export function nextPingAt(watch: Watch, expiresAt: number | null): number | null {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return null;
  const due = Math.max(watch.armedAt, expiresAt - 5 * 60_000);
  return watch.lastAttemptAt !== null && watch.lastAttemptAt >= due ? null : due;
}
export function estimateExpiry(providerId: string, sample: Sample | null, offer?: string | null) {
  const deadline = offer ? Date.parse(offer) : NaN;
  if (Number.isFinite(deadline)) return { at: deadline, source: 'provider' as const };
  if (sample?.ttlMs && sample.ttlMs > 0) return { at: sample.at + sample.ttlMs, source: 'provider' as const };
  if ((providerId === 'codex' || providerId === 'central-codex') && sample
    && (sample.readTokens > 0 || (sample.writeTokens ?? 0) > 0))
    return { at: sample.at + 30 * 60_000, source: 'codex-assumption' as const };
  return { at: null, source: null };
}
export function eligible(thread: { status: string; runtime: { displayStatus: string }; archivedAt: number | null; deletedAt: number | null; activeBackgroundAgentCount: number; queuedMessageCount: number }): boolean {
  return thread.status === 'idle' && thread.runtime.displayStatus === 'idle'
    && thread.archivedAt === null && thread.deletedAt === null
    && thread.activeBackgroundAgentCount === 0 && thread.queuedMessageCount === 0;
}
