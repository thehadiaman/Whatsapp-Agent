import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import type { PipelineSettings } from './config.js';

export const QUEUES = {
  webhooks: 'whatsapp-webhooks',
  outbound: 'whatsapp-outbound',
  media: 'whatsapp-media',
  assistant: 'assistant-turns',
  knowledge: 'knowledge-ingest',
  transcription: 'voice-transcription',
} as const;

// Job data is validated when a job is taken, like any other boundary (brief §7).
export const webhookJobSchema = z.object({ eventId: z.uuid() });
export const tenantMessageJobSchema = z.object({ tenantId: z.uuid(), messageId: z.uuid() });
export type TenantMessageJob = z.infer<typeof tenantMessageJobSchema>;
/** One job per customer message; the newest unanswered message in a burst gets the reply. */
export const assistantJobSchema = z.object({
  tenantId: z.uuid(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
});
export type AssistantJob = z.infer<typeof assistantJobSchema>;

export interface Queues {
  webhooks: Queue;
  outbound: Queue;
  media: Queue;
  assistant: Queue;
  knowledge: Queue;
  transcription: Queue;
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
  // Retried for model and network errors; the last attempt hands over to a person.
  const assistant = new Queue(QUEUES.assistant, {
    connection,
    prefix,
    defaultJobOptions: { ...keep, attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
  });
  const knowledge = new Queue(QUEUES.knowledge, {
    connection,
    prefix,
    defaultJobOptions: { ...keep, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  });
  // Transcribe jobs take seconds to minutes; the last attempt hands the note to a person.
  const transcription = new Queue(QUEUES.transcription, {
    connection,
    prefix,
    defaultJobOptions: { ...keep, attempts: 4, backoff: { type: 'exponential', delay: 2_000 } },
  });
  return {
    webhooks,
    outbound,
    media,
    assistant,
    knowledge,
    transcription,
    close: async () => {
      await Promise.all([
        webhooks.close(),
        outbound.close(),
        media.close(),
        assistant.close(),
        knowledge.close(),
        transcription.close(),
      ]);
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

/**
 * Keyed by message ID: a duplicate webhook or a sweep cannot answer a message
 * twice. `after` names a later event that needs a fresh job for the same
 * message (a transcript arriving), since a finished job's ID stays taken; the
 * turn's unique trigger still allows one answer.
 */
export async function enqueueAssistant(
  queues: Queues,
  job: AssistantJob,
  delayMs: number,
  after?: string,
): Promise<void> {
  await queues.assistant.add('turn', job, {
    jobId: after ? `${job.messageId}-after-${after}` : job.messageId,
    delay: delayMs,
  });
}

/** One transcription per voice note. */
export async function enqueueTranscription(queues: Queues, job: TenantMessageJob): Promise<void> {
  await queues.transcription.add('transcribe', job, { jobId: job.messageId });
}

/** Keyed by source and version: an edit while reading queues the new version separately. */
export async function enqueueKnowledge(
  queues: Queues,
  job: { tenantId: string; sourceId: string; version: number },
): Promise<void> {
  // BullMQ job IDs may not contain ":".
  await queues.knowledge.add('ingest', job, { jobId: `${job.sourceId}-v${String(job.version)}` });
}
