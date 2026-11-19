import { schema } from '@app/db';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { and, isNull, lt, sql } from 'drizzle-orm';
import { recordDeadLetter } from './dead-letters.js';
import type { PipelineDeps } from './deps.js';
import { processWebhookEvent } from './inbound.js';
import { fetchInboundMedia } from './media.js';
import { sendOutbound } from './outbound.js';
import { enqueueOutbound, enqueueWebhookEvent, QUEUES, webhookJobSchema } from './queues.js';

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
 * Starts the three pipeline workers and the sweeper. Used by apps/worker and
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

  for (const worker of [webhooks, outbound, media]) {
    // Without an error listener a worker can stop processing (BullMQ docs).
    worker.on('error', (error) => {
      log.error({ err: error, queue: worker.name }, 'worker error');
    });
  }
  // Outbound records its own dead letters; these two do it when retries run out.
  for (const worker of [webhooks, media]) {
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
      await Promise.all([webhooks.close(), outbound.close(), media.close()]);
    },
  };
}
