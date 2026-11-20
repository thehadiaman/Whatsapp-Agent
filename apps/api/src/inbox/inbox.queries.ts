import { schema, type StoredMedia, type StoredTranscript, type Transaction } from '@app/db';
import { windowState } from '@app/pipeline';
import type {
  ConversationDetail,
  ConversationListItem,
  ConversationState,
  TimelineEntry,
  TimelineMessage,
} from '@app/shared';
import { asc, eq, sql } from 'drizzle-orm';

/**
 * Read models for the inbox. Always called inside TenantDb.run(), so row-level
 * security limits every table here to the caller's tenant.
 */

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function windowClosesAt(lastInboundAt: Date | string | null): string | null {
  return iso(windowState(lastInboundAt ? new Date(lastInboundAt) : null, new Date()).closesAt);
}

function transcriptView(t: StoredTranscript | null): TimelineMessage['transcript'] {
  if (!t) return null;
  if (t.status === 'done') {
    return { status: 'done', text: t.text, language: t.language, engine: t.engine };
  }
  return t;
}

/** One line of text for the queue, whatever the message kind. */
export function previewOf(
  kind: string,
  body: string | null,
  media: StoredMedia | null,
  transcript: StoredTranscript | null = null,
): string {
  switch (kind) {
    case 'text':
      return (body ?? '').slice(0, 140);
    case 'image':
      return media?.caption ? `Photo: ${media.caption}` : 'Photo';
    case 'document':
      return `Document${media?.filename ? `: ${media.filename}` : ''}`;
    case 'audio': {
      const label = media?.voice || !media ? 'Voice note' : 'Audio file';
      // What was said: the transcript of a customer's note, the text of a spoken reply.
      const words = transcript?.status === 'done' ? transcript.text : body;
      return words ? `${label}: ${words}`.slice(0, 140) : label;
    }
    case 'template':
      return 'Template message';
    default:
      return 'Message type not supported yet';
  }
}

interface ListRow extends Record<string, unknown> {
  id: string;
  number: number;
  state: ConversationState;
  holder_user_id: string | null;
  holder_name: string | null;
  profile_name: string | null;
  wa_id: string | null;
  last_inbound_at: Date | string | null;
  lm_direction: 'inbound' | 'outbound' | null;
  lm_kind: string | null;
  lm_body: string | null;
  lm_media: StoredMedia | null;
  lm_transcript: StoredTranscript | null;
  lm_at: Date | string | null;
  waiting_since: Date | string | null;
}

export async function listConversations(
  tx: Transaction,
  scope: 'open' | 'closed',
): Promise<ConversationListItem[]> {
  const result = await tx.execute<ListRow>(sql`
    select c.id, c.number, c.state, c.holder_user_id, hu.name as holder_name,
           cu.profile_name, cu.wa_id, c.last_inbound_at,
           lm.direction as lm_direction, lm.kind as lm_kind, lm.body as lm_body,
           lm.media as lm_media, lm.transcript as lm_transcript, lm.at as lm_at,
           wt.created_at as waiting_since
    from conversations c
    join customers cu on cu.id = c.customer_id
    left join users hu on hu.id = c.holder_user_id
    left join lateral (
      select m.direction, m.kind, m.body, m.media, m.transcript,
             coalesce(m.wa_timestamp, m.created_at) as at
      from messages m where m.conversation_id = c.id
      order by coalesce(m.wa_timestamp, m.created_at) desc limit 1
    ) lm on true
    left join lateral (
      select t.created_at from conversation_transitions t
      where t.conversation_id = c.id and t.to_state = 'waiting_for_human'
      order by t.created_at desc limit 1
    ) wt on c.state = 'waiting_for_human'
    where ${scope === 'open' ? sql`c.state <> 'closed'` : sql`c.state = 'closed'`}
    order by c.last_message_at desc nulls last
    limit ${scope === 'open' ? 500 : 100}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    number: row.number,
    state: row.state,
    holder:
      row.holder_user_id && row.holder_name
        ? { id: row.holder_user_id, name: row.holder_name }
        : null,
    customer: { name: row.profile_name, phone: row.wa_id },
    lastMessage:
      row.lm_direction && row.lm_kind && row.lm_at
        ? {
            direction: row.lm_direction,
            preview: previewOf(row.lm_kind, row.lm_body, row.lm_media, row.lm_transcript),
            at: new Date(row.lm_at).toISOString(),
          }
        : null,
    waitingSince: iso(row.waiting_since),
    windowClosesAt: windowClosesAt(row.last_inbound_at),
  }));
}

export async function conversationDetail(
  tx: Transaction,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const [row] = await tx
    .select({
      conversation: schema.conversations,
      customer: schema.customers,
      channel: schema.channels,
      holderName: schema.users.name,
      voiceReplies: schema.tenants.voiceReplies,
    })
    .from(schema.conversations)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
    .innerJoin(schema.channels, eq(schema.channels.id, schema.conversations.channelId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.conversations.tenantId))
    .leftJoin(schema.users, eq(schema.users.id, schema.conversations.holderUserId))
    .where(eq(schema.conversations.id, conversationId));
  if (!row) return null;

  // Sequential on purpose: one transaction is one connection, which runs one
  // query at a time (pg 9 rejects overlapping queries on a client).
  const messages = await tx
    .select({
      message: schema.messages,
      senderName: schema.users.name,
      turnId: schema.assistantTurns.id,
    })
    .from(schema.messages)
    .leftJoin(schema.users, eq(schema.users.id, schema.messages.senderUserId))
    .leftJoin(schema.assistantTurns, eq(schema.assistantTurns.replyMessageId, schema.messages.id))
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));
  const transitions = await tx
    .select({ transition: schema.conversationTransitions, actorName: schema.users.name })
    .from(schema.conversationTransitions)
    .leftJoin(schema.users, eq(schema.users.id, schema.conversationTransitions.actorUserId))
    .where(eq(schema.conversationTransitions.conversationId, conversationId));
  const notes = await tx
    .select({ note: schema.conversationNotes, authorName: schema.users.name })
    .from(schema.conversationNotes)
    .leftJoin(schema.users, eq(schema.users.id, schema.conversationNotes.authorUserId))
    .where(eq(schema.conversationNotes.conversationId, conversationId));

  const timeline: TimelineEntry[] = [
    ...messages.map(({ message: m, senderName, turnId }): TimelineEntry => ({
      type: 'message',
      id: m.id,
      // Inbound: when the customer sent it. Outbound: when it was written here.
      at: (m.direction === 'inbound' && m.waTimestamp ? m.waTimestamp : m.createdAt).toISOString(),
      direction: m.direction,
      kind: m.kind,
      senderType: m.senderType,
      senderName,
      body: m.body,
      templateName: m.templateName,
      media: m.media
        ? {
            mimeType: m.media.mimeType,
            caption: m.media.caption,
            filename: m.media.filename ?? null,
            voice: m.media.voice ?? false,
            available: Boolean(m.media.storageKey),
            durationMs: m.media.durationMs ?? null,
          }
        : null,
      transcript: transcriptView(m.transcript),
      speech: m.speech
        ? {
            language: m.speech.language,
            voiceId: m.speech.voiceId,
            fallback: m.speech.fallback,
            engine: m.speech.engine ?? null,
            durationMs: m.speech.durationMs ?? null,
          }
        : null,
      status: m.status,
      error: m.error,
      turnId,
    })),
    ...transitions.map(({ transition: t, actorName }): TimelineEntry => ({
      type: 'transition',
      id: t.id,
      at: t.createdAt.toISOString(),
      from: t.fromState,
      to: t.toState,
      actorType: t.actorType,
      actorName,
      reason: t.reason,
    })),
    ...notes.map(({ note: n, authorName }): TimelineEntry => ({
      type: 'note',
      id: n.id,
      at: n.createdAt.toISOString(),
      authorName,
      body: n.body,
    })),
  ];
  const order = { transition: 0, message: 1, note: 2 } as const;
  timeline.sort((a, b) => a.at.localeCompare(b.at) || order[a.type] - order[b.type]);

  const c = row.conversation;
  return {
    id: c.id,
    number: c.number,
    state: c.state,
    holder: c.holderUserId && row.holderName ? { id: c.holderUserId, name: row.holderName } : null,
    customer: {
      name: row.customer.profileName,
      phone: row.customer.waId,
      firstSeenAt: row.customer.createdAt.toISOString(),
    },
    channel: {
      displayPhoneNumber: row.channel.displayPhoneNumber,
      reopenTemplateName: row.channel.reopenTemplateName,
    },
    windowClosesAt: windowClosesAt(c.lastInboundAt),
    voiceReplies: row.voiceReplies,
    timeline,
  };
}
