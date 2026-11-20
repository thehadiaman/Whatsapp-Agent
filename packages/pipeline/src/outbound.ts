import {
  schema,
  withTenant,
  type SpeechFallback,
  type StoredError,
  type StoredMedia,
  type StoredSpeech,
  type Transaction,
} from '@app/db';
import {
  POLLY_VOICES,
  readOggOpus,
  SPOKEN_LANGUAGES,
  VOICE_NOTE_PLAYABLE_BYTES,
  type SpokenLanguage,
} from '@app/voice';
import { GraphApiError, type OutboundContent, type Recipient } from '@app/whatsapp';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { NotFoundError } from './conversations.js';
import { recordDeadLetter } from './dead-letters.js';
import { nowOf, type PipelineDeps } from './deps.js';
import { QUEUES, tenantMessageJobSchema } from './queues.js';
import {
  assistantMessageMayGo,
  decideSend,
  maySend,
  nextStatus,
  planSpeech,
  windowState,
  type MessageStatus,
} from './rules.js';
import { applyStatusEvents } from './statuses.js';
import { mediaKey } from './storage.js';

export type Sender = { type: 'assistant' } | { type: 'user'; userId: string };
export type ReplyContent =
  | { kind: 'text'; body: string }
  | { kind: 'template'; name: string; languageCode: string }
  /** Text to speak as a voice note; it goes as text when it cannot be spoken. */
  | { kind: 'voice'; body: string; language: SpokenLanguage };

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class WindowClosedError extends Error {
  constructor() {
    super(
      'The 24-hour reply window is closed. Free text cannot be sent; send an approved template to reopen the conversation.',
    );
    this.name = 'WindowClosedError';
  }
}

/**
 * Queues a reply in the caller's transaction (the transactional outbox): the
 * message row is the outbox entry, numbered per conversation. The caller
 * enqueues the send job after commit; if that enqueue is lost, the sweeper
 * finds the row and enqueues it.
 */
export async function queueReply(
  tx: Transaction,
  input: { conversationId: string; sender: Sender; content: ReplyContent; now: Date },
): Promise<string> {
  const [conversation] = await tx
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, input.conversationId))
    .for('update');
  if (!conversation) throw new NotFoundError();
  if (!maySend(conversation.state, conversation.holderUserId, input.sender)) {
    throw new OwnershipError(
      input.sender.type === 'assistant'
        ? 'A person holds this conversation; the assistant cannot reply.'
        : 'Take over the conversation before replying.',
    );
  }
  // Only an approved template may go outside the window; a voice note is free-form too.
  if (
    input.content.kind !== 'template' &&
    !windowState(conversation.lastInboundAt, input.now).open
  ) {
    throw new WindowClosedError();
  }

  const content = input.content;
  let kind: 'text' | 'template' | 'audio' = content.kind === 'voice' ? 'audio' : content.kind;
  let speech: StoredSpeech | null = null;
  if (content.kind === 'voice') {
    const plan = planSpeech(content.body, content.language);
    speech = { language: plan.language, voiceId: plan.voiceId, fallback: plan.fallback };
    if (!plan.voiceId) kind = 'text';
  }

  const seq = conversation.nextOutboxSeq;
  await tx
    .update(schema.conversations)
    .set({ nextOutboxSeq: seq + 1, lastMessageAt: input.now, updatedAt: input.now })
    .where(eq(schema.conversations.id, conversation.id));

  const [message] = await tx
    .insert(schema.messages)
    .values({
      tenantId: conversation.tenantId,
      channelId: conversation.channelId,
      conversationId: conversation.id,
      direction: 'outbound',
      kind,
      senderType: input.sender.type,
      senderUserId: input.sender.type === 'user' ? input.sender.userId : null,
      // A voice reply keeps its text (brief §4): it is what the inbox shows.
      body: content.kind === 'template' ? null : content.body,
      templateName: content.kind === 'template' ? content.name : null,
      templateLanguage: content.kind === 'template' ? content.languageCode : null,
      speech,
      status: 'queued',
      statusAt: input.now,
      outboxSeq: seq,
    })
    .returning({ id: schema.messages.id });
  if (!message) throw new Error('queueReply: insert returned no row');
  return message.id;
}

type Prepared =
  | { kind: 'skip'; reason: string; changedConversationId?: string }
  | { kind: 'wait'; until: Date }
  | {
      kind: 'send';
      conversationId: string;
      provider: 'meta' | 'simulator';
      phoneNumberId: string;
      channelId: string;
      recipient: Recipient;
      content: OutboundContent;
      /** Audio still to be made or uploaded before sending. */
      voice: { body: string; speech: StoredSpeech; media: StoredMedia | null } | null;
      attempt: number;
    };

/**
 * Sends one queued reply. Within the conversation (serialised by an advisory
 * lock) it checks, in order: the message is still queued; the assistant does
 * not hold a conversation a person took over (brief §4); every earlier reply
 * was sent and, up to the hold time, delivered (P-02); the 24-hour window is
 * open for free text. Then it calls the API outside any transaction.
 */
export async function sendOutbound(deps: PipelineDeps, job: Job, token?: string): Promise<void> {
  const { tenantId, messageId } = tenantMessageJobSchema.parse(job.data);
  const now = nowOf(deps);

  const prepared = await withTenant(deps.db, tenantId, async (tx): Promise<Prepared> => {
    const [peek] = await tx
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    // Not visible: deleted, or the job names a tenant that does not own it.
    if (!peek) return { kind: 'skip', reason: 'message not found for this tenant' };

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${peek.conversationId}::text, 0))`,
    );
    const [message] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .for('update');
    if (!message || message.direction !== 'outbound' || message.outboxSeq === null) {
      return { kind: 'skip', reason: 'not an outbound message' };
    }
    if (message.status !== 'queued' && message.status !== 'sending') {
      return { kind: 'skip', reason: `already ${message.status}` };
    }

    const [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, message.conversationId));
    if (!conversation) return { kind: 'skip', reason: 'conversation not found' };

    if (message.senderType === 'assistant' && !assistantMessageMayGo(conversation.state)) {
      await tx
        .update(schema.messages)
        .set({ status: 'cancelled', statusAt: now })
        .where(eq(schema.messages.id, message.id));
      return {
        kind: 'skip',
        reason: 'a person took over; assistant reply cancelled',
        changedConversationId: message.conversationId,
      };
    }

    const earlier = await tx
      .select({
        outboxSeq: schema.messages.outboxSeq,
        status: schema.messages.status,
        sentAt: schema.messages.sentAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, message.conversationId),
          lt(schema.messages.outboxSeq, message.outboxSeq),
          gte(schema.messages.outboxSeq, message.outboxSeq - 50),
        ),
      )
      .orderBy(asc(schema.messages.outboxSeq));
    const decision = decideSend(
      { outboxSeq: message.outboxSeq, status: message.status, sentAt: message.sentAt },
      earlier.map((e) => ({ outboxSeq: e.outboxSeq ?? 0, status: e.status, sentAt: e.sentAt })),
      now,
      deps.settings.orderHoldMs,
    );
    if (decision.action === 'wait') return { kind: 'wait', until: decision.until };

    if (message.kind !== 'template' && !windowState(conversation.lastInboundAt, now).open) {
      await fail(tx, message.id, now, { code: 131047, message: new WindowClosedError().message });
      return {
        kind: 'skip',
        reason: 'window closed',
        changedConversationId: message.conversationId,
      };
    }

    const [channel] = await tx
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, message.channelId));
    const [customer] = await tx
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, conversation.customerId));
    if (!channel || !customer) return { kind: 'skip', reason: 'channel or customer missing' };

    await tx
      .update(schema.messages)
      .set({ status: 'sending', statusAt: now, attempts: message.attempts + 1 })
      .where(eq(schema.messages.id, message.id));

    const recipient: Recipient = customer.bsuid
      ? { bsuid: customer.bsuid }
      : { phone: customer.waId ?? '' };
    const content: OutboundContent =
      message.kind === 'template'
        ? {
            kind: 'template',
            name: message.templateName ?? '',
            languageCode: message.templateLanguage ?? 'en',
          }
        : { kind: 'text', body: message.body ?? '' };
    return {
      kind: 'send',
      conversationId: message.conversationId,
      provider: channel.provider,
      phoneNumberId: channel.phoneNumberId,
      channelId: channel.id,
      recipient,
      content,
      voice:
        message.kind === 'audio' && message.speech
          ? { body: message.body ?? '', speech: message.speech, media: message.media }
          : null,
      attempt: message.attempts + 1,
    };
  });

  if (prepared.kind === 'skip') {
    deps.logger.info({ messageId, reason: prepared.reason }, 'outbound skipped');
    if (prepared.changedConversationId) {
      await deps.events.conversationChanged(tenantId, prepared.changedConversationId);
    }
    return;
  }
  if (prepared.kind === 'wait') {
    // Not a failure: re-run later without using up an attempt.
    await job.moveToDelayed(prepared.until.getTime(), token);
    throw new DelayedError();
  }

  try {
    const client = deps.providers.client(prepared.provider);
    const content = prepared.voice
      ? await voiceContent(deps, tenantId, messageId, prepared.voice, (file) =>
          client.uploadMedia(prepared.phoneNumberId, file),
        )
      : prepared.content;
    const wamid = await client.sendMessage(prepared.phoneNumberId, prepared.recipient, content);
    await withTenant(deps.db, tenantId, async (tx) => {
      const [current] = await tx
        .select({ status: schema.messages.status })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId))
        .for('update');
      const sentAt = nowOf(deps);
      await tx
        .update(schema.messages)
        .set({
          waMessageId: wamid,
          status: nextStatus(current?.status ?? 'sending', 'sent'),
          statusAt: sentAt,
          sentAt,
          error: null,
        })
        .where(eq(schema.messages.id, messageId));
      // Statuses that arrived before this send returned can apply now.
      await applyStatusEvents(tx, prepared.channelId, wamid);
    });
    await deps.events.conversationChanged(tenantId, prepared.conversationId);
    deps.logger.info({ messageId, attempt: prepared.attempt }, 'outbound sent');
  } catch (error) {
    await handleSendError(deps, job, tenantId, messageId, prepared.conversationId, error);
  }
}

/**
 * Makes and uploads the voice note for a spoken reply, reusing what an
 * earlier attempt already did. If it cannot be spoken (synthesis failed, or
 * the note is too big for WhatsApp to play inline), the message becomes text
 * and says why: the customer gets the answer either way.
 */
async function voiceContent(
  deps: PipelineDeps,
  tenantId: string,
  messageId: string,
  voice: { body: string; speech: StoredSpeech; media: StoredMedia | null },
  upload: (file: { bytes: Uint8Array; mimeType: string; filename: string }) => Promise<string>,
): Promise<OutboundContent> {
  if (voice.media?.id) return { kind: 'audio', mediaId: voice.media.id, voice: true };

  const asText = async (fallback: SpeechFallback): Promise<OutboundContent> => {
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(schema.messages)
        .set({ kind: 'text', speech: { ...voice.speech, fallback } })
        .where(eq(schema.messages.id, messageId)),
    );
    deps.logger.warn({ messageId, fallback }, 'voice reply sent as text');
    return { kind: 'text', body: voice.body };
  };

  const key = mediaKey(tenantId, messageId);
  let audio = await deps.storage.get(key);
  if (!audio) {
    const pollyVoice = isSpokenLanguage(voice.speech.language)
      ? POLLY_VOICES[voice.speech.language]
      : null;
    if (!pollyVoice) return asText('no_voice');
    try {
      const made = await deps.voice.tts.synthesize({ text: voice.body, voice: pollyVoice });
      audio = { bytes: made.bytes, contentType: made.mimeType };
    } catch (error) {
      // Falling back at once beats retrying: the customer is waiting for an answer.
      deps.logger.warn(
        { messageId, err: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
        'speech synthesis failed',
      );
      return asText('synthesis_failed');
    }
    if (audio.bytes.byteLength > VOICE_NOTE_PLAYABLE_BYTES) return asText('too_large');
    await deps.storage.put(key, audio.bytes, audio.contentType);
  }

  let durationMs: number | undefined;
  try {
    durationMs = readOggOpus(audio.bytes).durationMs;
  } catch {
    durationMs = undefined;
  }
  // WhatsApp lists voice notes as audio/ogg (Opus only); the codec parameter is ours.
  const mediaId = await upload({
    bytes: audio.bytes,
    mimeType: 'audio/ogg',
    filename: 'reply.ogg',
  });
  const media: StoredMedia = {
    id: mediaId,
    mimeType: audio.contentType,
    sha256: null,
    caption: null,
    voice: true,
    storageKey: key,
    sizeBytes: audio.bytes.byteLength,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  await withTenant(deps.db, tenantId, (tx) =>
    tx
      .update(schema.messages)
      .set({
        media,
        speech: {
          ...voice.speech,
          engine: deps.voice.tts.engine,
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      })
      .where(eq(schema.messages.id, messageId)),
  );
  return { kind: 'audio', mediaId, voice: true };
}

function isSpokenLanguage(value: string): value is SpokenLanguage {
  return (SPOKEN_LANGUAGES as readonly string[]).includes(value);
}

async function handleSendError(
  deps: PipelineDeps,
  job: Job,
  tenantId: string,
  messageId: string,
  conversationId: string,
  error: unknown,
): Promise<never> {
  const graph = error instanceof GraphApiError ? error : null;
  const stored: StoredError = {
    code: graph?.code ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
  };
  const attempts = job.opts.attempts ?? 1;
  const finalAttempt = job.attemptsMade + 1 >= attempts;
  const retryable = graph?.retryable ?? false;
  const now = nowOf(deps);

  if (graph?.ambiguous) {
    deps.logger.warn({ messageId }, 'send outcome unknown (no response); a retry may duplicate it');
  }

  if (retryable && !finalAttempt) {
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(schema.messages)
        .set({ status: 'queued', statusAt: now, error: stored })
        .where(eq(schema.messages.id, messageId)),
    );
    deps.logger.warn(
      { messageId, code: stored.code, attempt: job.attemptsMade + 1 },
      'outbound failed; will retry',
    );
    await deps.events.conversationChanged(tenantId, conversationId);
    throw error;
  }

  await withTenant(deps.db, tenantId, (tx) => fail(tx, messageId, now, stored));
  await recordDeadLetter(deps.db, {
    tenantId,
    queue: QUEUES.outbound,
    reference: messageId,
    reason: retryable
      ? `gave up after ${String(attempts)} attempts: ${stored.message}`
      : `permanent error: ${stored.message}`,
    attempts: job.attemptsMade + 1,
  });
  deps.logger.error({ messageId, code: stored.code }, 'outbound failed permanently');
  await deps.events.conversationChanged(tenantId, conversationId);
  throw new UnrecoverableError(stored.message);
}

async function fail(
  tx: Transaction,
  messageId: string,
  now: Date,
  error: StoredError,
): Promise<void> {
  await tx
    .update(schema.messages)
    .set({ status: 'failed' satisfies MessageStatus, statusAt: now, error })
    .where(eq(schema.messages.id, messageId));
}
