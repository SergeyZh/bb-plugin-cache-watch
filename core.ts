import { z } from 'zod';

export const PING = '[Cache Watch keepalive] This turn only refreshes the prompt cache. Reply exactly: OK. Do not use tools, edit files, resume tasks, create goals, or perform any other action.';
export const watchInput = z.object({
  threadId: z.string().regex(/^thr_[a-z0-9]+$/),
  intervalMinutes: z.number().int().min(2).max(55).default(4),
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
export function nextPingAt(watch: Watch, sample: Sample | null): number {
  return Math.max(watch.armedAt, watch.lastAttemptAt ?? 0, sample?.at ?? 0) + watch.intervalMinutes * 60_000;
}
export function eligible(thread: { status: string; runtime: { displayStatus: string }; archivedAt: number | null; deletedAt: number | null; activeBackgroundAgentCount: number; queuedMessageCount: number }): boolean {
  return thread.status === 'idle' && thread.runtime.displayStatus === 'idle'
    && thread.archivedAt === null && thread.deletedAt === null
    && thread.activeBackgroundAgentCount === 0 && thread.queuedMessageCount === 0;
}
