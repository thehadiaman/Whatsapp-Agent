import { schema } from '@app/db';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { and, isNull, lt, sql } from 'drizzle-orm';
import { processAssistantJob } from './assistant.js';
import { recordDeadLetter } from './dead-letters.js';
import type { PipelineDeps } from './deps.js';
import { processWebhookEvent } from './inbound.js';
import { failKnowledgeJob, ingestKnowledgeSource } from './knowledge.js';
import { fetchInboundMedia } from './media.js';
import { sendOutbound } from './outbound.js';
import {
  enqueueAssistant,
  enqueueKnowledge,
  enqueueMedia,
  enqueueOutbound,
  enqueueTranscription,
  enqueueWebhookEvent,
  QUEUES,
  tenantMessageJobSchema,
  webhookJobSchema,
} from './queues.js';
import { failTranscript, transcribeVoiceNote } from './voice.js';

/** Queues every knowledge source whose passages another embedding model made. */
export async function requeueStaleEmbeddings(deps: PipelineDeps): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await deps.db.execute<{ tenant_id: string; source_id: string; version: number }>(
      sql`select tenant_id, source_id, version from requeue_stale_embeddings(${deps.assistant.embedder.model}, 100)`,
    );
    for (const row of result.rows) {
      await enqueueKnowledge(deps.queues, {
        tenantId: row.tenant_id,
        sourceId: row.source_id,
        version: row.version,
      });
    }
    total += result.rows.length;
    if (result.rows.length < 100) break;
  }
  if (total > 0) deps.logger.info({ sources: total }, 'knowledge queued for re-embedding');
  return total;
}

export interface RunningWorkers {
  close(): Promise<void>;
  /** Runs one sweep now (tests). */
  sweep(): Promise<void>;
}

export interface WorkerOptions {
  /** Separate connection settings for blocking worker connections. */
  connection: ConnectionOptions;
  sweepIntervalMs?: number;
  /** How old an unprocessed event or queued reply must be before the sweeper re-enqueues it. */
  sweepAfterSeconds?: number;
  /** Must match the queues' prefix. */
  prefix?: string;
}

/**
 * Starts the pipeline workers (webhooks, outbound, media, assistant,
 * knowledge, transcription) and the sweeper. Used by apps/worker and
 * by integration tests, so tests run exactly the production wiring.
 */
export function startWorkers(deps: PipelineDeps, options: WorkerOptions): RunningWorkers {
  const { connection } = options;
  const prefix = options.prefix ?? 'bull';
  const log = deps.logger;

  const webhooks = new Worker(
    QUEUES.webhooks,
    async (job: Job) => {
      await processWebhookEvent(deps, webhookJobSchema.parse(job.data).eventId);
    },
    { connection, prefix, concurrency: 4 },
  );
  // Replies are sent concurrently across conversations; ordering within one
  // conversation comes from the advisory lock and outbox sequence, not from here.
  const outbound = new Worker(
    QUEUES.outbound,
    (job: Job, token?: string) => sendOutbound(deps, job, token),
    { connection, prefix, concurrency: 8 },
  );
  const media = new Worker(QUEUES.media, (job: Job) => fetchInboundMedia(deps, job), {
    connection,
    prefix,
    concurrency: 2,
  });

  // Turns call a model: a few at a time keeps a burst from exhausting quotas.
  const assistant = new Worker(QUEUES.assistant, (job: Job) => processAssistantJob(deps, job), {
    connection,
    prefix,
    concurrency: 4,
  });
  // Reading a PDF is CPU-bound; one at a time keeps replies fast on a small server.
  const knowledge = new Worker(QUEUES.knowledge, (job: Job) => ingestKnowledgeSource(deps, job), {
    connection,
    prefix,
    concurrency: 1,
  });
  // Transcription is network-bound (Transcribe polls); a couple at a time.
  const transcription = new Worker(
    QUEUES.transcription,
    (job: Job) => transcribeVoiceNote(deps, job),
    { connection, prefix, concurrency: 2 },
  );
  // A voice note whose file could not be copied can never be transcribed:
  // settle it so the assistant hands the conversation to a person.
  media.on('failed', (job) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const parsed = tenantMessageJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    void failTranscript(
      deps,
      parsed.data.tenantId,
      parsed.data.messageId,
      'the voice note could not be downloaded from WhatsApp',
    ).catch((err: unknown) => {
      log.error({ err }, 'could not mark transcript failed');
    });
  });
  knowledge.on('failed', (job) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void failKnowledgeJob(deps, job).catch((err: unknown) => {
      log.error({ err }, 'could not mark knowledge source failed');
    });
  });

  for (const worker of [webhooks, outbound, media, assistant, knowledge, transcription]) {
    // Without an error listener a worker can stop processing (BullMQ docs).
    worker.on('error', (error) => {
      log.error({ err: error, queue: worker.name }, 'worker error');
    });
  }
  // Outbound and the assistant record their own outcome; these do it when retries run out.
  for (const worker of [webhooks, media, knowledge, transcription]) {
    worker.on('failed', (job, error) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      void recordDeadLetter(deps.db, {
        tenantId: (job.data as { tenantId?: string }).tenantId ?? null,
        queue: worker.name,
        reference: job.id ?? 'unknown',
        reason: error.message.slice(0, 300),
        attempts: job.attemptsMade,
      }).catch((err: unknown) => {
        log.error({ err }, 'could not record dead letter');
      });
    });
  }

  // Knowledge embedded by another model is re-read with this one (D-093).
  void requeueStaleEmbeddings(deps).catch((error: unknown) => {
    log.error({ err: error }, 'could not queue knowledge for re-embedding');
  });

  const sweepAfter = options.sweepAfterSeconds ?? 30;
  const sweep = async () => {
    // Raw events whose job was lost between insert and enqueue.
    const events = await deps.db
      .select({ id: schema.webhookEvents.id })
      .from(schema.webhookEvents)
      .where(
        and(
          isNull(schema.webhookEvents.processedAt),
          lt(schema.webhookEvents.receivedAt, sql`now() - make_interval(secs => ${sweepAfter})`),
        ),
      )
      .limit(100);
    for (const event of events) await enqueueWebhookEvent(deps.queues, event.id);

    // Replies whose send job was lost (the outbox row is the source of truth).
    const pending = await deps.db.execute<{ tenant_id: string; message_id: string }>(
      sql`select tenant_id, message_id from pending_outbound(make_interval(secs => ${sweepAfter}), 100)`,
    );
    for (const row of pending.rows) {
      await enqueueOutbound(deps.queues, { tenantId: row.tenant_id, messageId: row.message_id });
    }

    // Knowledge sources whose ingest job was lost.
    const sources = await deps.db.execute<{
      tenant_id: string;
      source_id: string;
      version: number;
    }>(
      sql`select tenant_id, source_id, version from pending_knowledge_sources(make_interval(secs => ${sweepAfter * 10}), 50)`,
    );
    for (const row of sources.rows) {
      await enqueueKnowledge(deps.queues, {
        tenantId: row.tenant_id,
        sourceId: row.source_id,
        version: row.version,
      });
    }

    // Voice notes stuck waiting for a transcript: redo the copy or the transcription.
    const voiceNotes = await deps.db.execute<{
      tenant_id: string;
      message_id: string;
      stored: boolean;
    }>(
      sql`select tenant_id, message_id, stored from pending_transcripts(make_interval(secs => ${sweepAfter}), make_interval(hours => 1), 100)`,
    );
    for (const row of voiceNotes.rows) {
      const job = { tenantId: row.tenant_id, messageId: row.message_id };
      await (row.stored ? enqueueTranscription(deps.queues, job) : enqueueMedia(deps.queues, job));
    }

    // Customer messages the assistant never answered (job lost after commit).
    // Only the last hour: an older silence is for a person to pick up.
    const unanswered = await deps.db.execute<{
      tenant_id: string;
      conversation_id: string;
      message_id: string;
    }>(
      sql`select tenant_id, conversation_id, message_id from unanswered_by_assistant(make_interval(secs => ${sweepAfter}), make_interval(hours => 1), 100)`,
    );
    for (const row of deps.assistant.settings.enabled ? unanswered.rows : []) {
      await enqueueAssistant(
        deps.queues,
        { tenantId: row.tenant_id, conversationId: row.conversation_id, messageId: row.message_id },
        0,
      );
    }
  };
  const timer = setInterval(() => {
    sweep().catch((error: unknown) => {
      log.error({ err: error }, 'sweep failed');
    });
  }, options.sweepIntervalMs ?? 30_000);
  timer.unref();

  return {
    sweep,
    close: async () => {
      clearInterval(timer);
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
