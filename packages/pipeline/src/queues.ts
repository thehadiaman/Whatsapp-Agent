import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import type { PipelineSettings } from './config.js';

export const QUEUES = {
  webhooks: 'whatsapp-webhooks',
  outbound: 'whatsapp-outbound',
  media: 'whatsapp-media',
} as const;

// Job data is validated when a job is taken, like any other boundary (brief §7).
export const webhookJobSchema = z.object({ eventId: z.uuid() });
export const tenantMessageJobSchema = z.object({ tenantId: z.uuid(), messageId: z.uuid() });
export type TenantMessageJob = z.infer<typeof tenantMessageJobSchema>;

export interface Queues {
  webhooks: Queue;
  outbound: Queue;
  media: Queue;
  close(): Promise<void>;
}

export function createQueues(
  connection: ConnectionOptions,
  settings: PipelineSettings,
  /** Redis key prefix. Tests use one per file so parallel files never share jobs. */
  prefix = 'bull',
): Queues {
  const keep = { removeOnComplete: { count: 1_000 }, removeOnFail: { count: 5_000 } };
  const webhooks = new Queue(QUEUES.webhooks, {
    connection,
    prefix,
    defaultJobOptions: { ...keep, attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
  });
  const outbound = new Queue(QUEUES.outbound, {
    connection,
    prefix,
    defaultJobOptions: {
      ...keep,
      attempts: settings.outboundAttempts,
      backoff: { type: 'exponential', delay: settings.outboundBackoffMs },
    },
  });
  const media = new Queue(QUEUES.media, {
    connection,
    prefix,
    defaultJobOptions: { ...keep, attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
  });
  return {
    webhooks,
    outbound,
    media,
    close: async () => {
      await Promise.all([webhooks.close(), outbound.close(), media.close()]);
    },
  };
}

/** One job per raw event; the job ID makes a repeated enqueue a no-op. */
export async function enqueueWebhookEvent(queues: Queues, eventId: string): Promise<void> {
  await queues.webhooks.add('process', { eventId }, { jobId: eventId });
}

/** One job per outbound message, keyed by message ID. */
export async function enqueueOutbound(queues: Queues, job: TenantMessageJob): Promise<void> {
  await queues.outbound.add('send', job, { jobId: job.messageId });
}

export async function enqueueMedia(queues: Queues, job: TenantMessageJob): Promise<void> {
  await queues.media.add('fetch', job, { jobId: job.messageId });
}
