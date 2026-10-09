import { createHash } from 'node:crypto';
import { z } from 'zod';
import { taskIdSchema } from '../shared/schemas.ts';

export const NOTIFICATION_TTL_MS = 24 * 60 * 60_000;

/** This is a wake/query hint, not an audio payload or a claim that the device spoke. */
export const resultSignalSchema = z.object({
  v: z.literal(1),
  type: z.literal('result_ready'),
  event_id: z.string().regex(/^[a-f0-9]{32}$/),
  task_id: taskIdSchema.refine((id) => /^T-\d{1,12}$/.test(id), 'Invalid notification task ID'),
  expires_at: z.number().int().positive(),
}).strict();

export type ResultSignal = z.infer<typeof resultSignalSchema>;

export function makeResultSignal(namespace: string, taskId: string, finishedAt: number): ResultSignal {
  return resultSignalSchema.parse({
    v: 1,
    type: 'result_ready',
    event_id: createHash('sha256').update(`${namespace}:${taskId}:${finishedAt}`).digest('hex').slice(0, 32),
    task_id: taskId,
    expires_at: finishedAt + NOTIFICATION_TTL_MS,
  });
}

export const notificationConfigSchema = z.object({
  url: z.url().refine((url) => url.startsWith('wss://'), 'Use authenticated TLS WebSockets'),
  device_id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  namespace: z.string().min(1),
  gateway: z.object({ username: z.string().min(1), password: z.string().min(32) }),
  device: z.object({ username: z.string().min(1), password: z.string().min(32) }),
});
