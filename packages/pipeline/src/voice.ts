import { schema, withTenant, type StoredTranscript } from '@app/db';
import { SPOKEN_LANGUAGES, TranscriptionError, type SpokenLanguage } from '@app/voice';
import type { Job } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PipelineDeps } from './deps.js';
import { enqueueAssistant, tenantMessageJobSchema } from './queues.js';

const known = (value: string): value is SpokenLanguage =>
  (SPOKEN_LANGUAGES as readonly string[]).includes(value);

/**
 * Transcribes one inbound voice note from our own copy of the file, with
 * language identification limited to the business's languages (brief §4).
 * The assistant waits for the transcript; whatever the outcome, it is then
 * asked to answer, so a voice note is never left without a reply or a person.
 */
export async function transcribeVoiceNote(deps: PipelineDeps, job: Job): Promise<void> {
  const { tenantId, messageId } = tenantMessageJobSchema.parse(job.data);
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  const target = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        kind: schema.messages.kind,
        media: schema.messages.media,
        transcript: schema.messages.transcript,
        languages: schema.tenants.languages,
      })
      .from(schema.messages)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.messages.tenantId))
      .where(eq(schema.messages.id, messageId));
    return row ?? null;
  });
  // Not visible (another tenant's ID), not a voice note, or already settled.
  if (target?.kind !== 'audio' || target.transcript?.status !== 'pending') return;
  const key = target.media?.storageKey;
  if (!key || !target.media) {
    // The copy job enqueues this once the file is stored; a sweep re-runs it.
    deps.logger.warn({ messageId }, 'voice note not stored yet; transcription skipped');
    return;
  }

  let settled: StoredTranscript;
  try {
    const file = await deps.storage.get(key);
    if (!file) throw new TranscriptionError('the voice note is missing from storage');
    const languages = target.languages.filter(known);
    const result = await deps.voice.stt.transcribe({
      audio: file.bytes,
      mimeType: target.media.mimeType,
      storageKey: key,
      languages: languages.length > 0 ? languages : ['en'],
    });
    settled = {
      status: 'done',
      text: result.text,
      language: result.language,
      engine: deps.voice.stt.engine,
      confidence: result.confidence,
    };
  } catch (error) {
    if (!(error instanceof TranscriptionError) && !lastAttempt) throw error;
    settled = {
      status: 'failed',
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
    };
  }
  await settleTranscript(deps, tenantId, messageId, settled);
}

/** Marks a voice note untranscribable (e.g. its download failed for good). */
export async function failTranscript(
  deps: PipelineDeps,
  tenantId: string,
  messageId: string,
  reason: string,
): Promise<void> {
  await settleTranscript(deps, tenantId, messageId, { status: 'failed', reason });
}

/**
 * Stores the outcome if the note is still pending, then asks the assistant to
 * answer the conversation's newest customer message: that turn reads this
 * note with whatever came after it.
 */
async function settleTranscript(
  deps: PipelineDeps,
  tenantId: string,
  messageId: string,
  transcript: StoredTranscript,
): Promise<void> {
  const m = schema.messages;
  const settled = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .update(m)
      .set({ transcript })
      .where(
        and(
          eq(m.id, messageId),
          eq(m.kind, 'audio'),
          sql`${m.transcript} ->> 'status' = 'pending'`,
        ),
      )
      .returning({ conversationId: m.conversationId });
    if (!row) return null;
    const [newest] = await tx
      .select({ id: m.id })
      .from(m)
      .where(and(eq(m.conversationId, row.conversationId), eq(m.direction, 'inbound')))
      .orderBy(desc(m.createdAt))
      .limit(1);
    return { conversationId: row.conversationId, newestId: newest?.id ?? messageId };
  });
  if (!settled) return;

  // IDs and outcome only: never the words (brief §4).
  deps.logger.info({ messageId, status: transcript.status }, 'voice note transcribed');
  if (deps.assistant.settings.enabled) {
    await enqueueAssistant(
      deps.queues,
      { tenantId, conversationId: settled.conversationId, messageId: settled.newestId },
      0,
      messageId,
    );
  }
  await deps.events.conversationChanged(tenantId, settled.conversationId);
}
