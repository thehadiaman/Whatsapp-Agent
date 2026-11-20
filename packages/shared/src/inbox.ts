import { z } from 'zod';

/** Shapes the inbox API returns and the web app validates. */

export const conversationStateSchema = z.enum([
  'assistant',
  'waiting_for_human',
  'human',
  'closed',
]);
export type ConversationState = z.infer<typeof conversationStateSchema>;

const person = z.object({ id: z.uuid(), name: z.string() });

export const customerSummarySchema = z.object({
  name: z.string().nullable(),
  /** WhatsApp number in international digits, or null for username-only customers. */
  phone: z.string().nullable(),
});

export const conversationListItemSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  state: conversationStateSchema,
  holder: person.nullable(),
  customer: customerSummarySchema,
  lastMessage: z
    .object({
      direction: z.enum(['inbound', 'outbound']),
      preview: z.string(),
      at: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  /** When the conversation last started waiting for a person; null unless waiting. */
  waitingSince: z.iso.datetime({ offset: true }).nullable(),
  /** End of the 24-hour reply window; null if the customer never wrote. */
  windowClosesAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

export const messageStatusSchema = z.enum([
  'received',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'cancelled',
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const timelineMessageSchema = z.object({
  type: z.literal('message'),
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  direction: z.enum(['inbound', 'outbound']),
  kind: z.enum(['text', 'image', 'document', 'audio', 'template', 'unsupported']),
  senderType: z.enum(['customer', 'assistant', 'user']),
  senderName: z.string().nullable(),
  body: z.string().nullable(),
  templateName: z.string().nullable(),
  media: z
    .object({
      mimeType: z.string(),
      caption: z.string().nullable(),
      filename: z.string().nullable(),
      voice: z.boolean(),
      /** True once the file is in our storage and can be fetched from /api/media/:id. */
      available: z.boolean(),
      /** Voice notes: length in milliseconds, when known. */
      durationMs: z.number().int().nullable(),
    })
    .nullable(),
  /** Inbound voice notes: the speech-to-text result, shown beside the player. */
  transcript: z
    .discriminatedUnion('status', [
      z.object({ status: z.literal('pending') }),
      z.object({
        status: z.literal('done'),
        text: z.string(),
        language: z.string(),
        /** `transcribe` (Amazon Transcribe) or `simulator` (mock mode). */
        engine: z.string(),
      }),
      z.object({ status: z.literal('failed'), reason: z.string() }),
    ])
    .nullable(),
  /** Replies meant to be spoken: the voice used, or why they went as text. */
  speech: z
    .object({
      language: z.string(),
      voiceId: z.string().nullable(),
      fallback: z.enum(['no_voice', 'too_long', 'too_large', 'synthesis_failed']).nullable(),
      engine: z.string().nullable(),
      durationMs: z.number().int().nullable(),
    })
    .nullable(),
  status: messageStatusSchema,
  error: z.object({ code: z.number().nullable(), message: z.string() }).nullable(),
  /** The assistant turn that wrote this reply; its receipt is "Explain this reply". */
  turnId: z.uuid().nullable(),
});
export type TimelineMessage = z.infer<typeof timelineMessageSchema>;

export const timelineTransitionSchema = z.object({
  type: z.literal('transition'),
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  from: conversationStateSchema.nullable(),
  to: conversationStateSchema,
  actorType: z.enum(['system', 'assistant', 'user']),
  actorName: z.string().nullable(),
  reason: z.string(),
});
export type TimelineTransition = z.infer<typeof timelineTransitionSchema>;

export const timelineNoteSchema = z.object({
  type: z.literal('note'),
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  authorName: z.string().nullable(),
  body: z.string(),
});
export type TimelineNote = z.infer<typeof timelineNoteSchema>;

export const timelineEntrySchema = z.discriminatedUnion('type', [
  timelineMessageSchema,
  timelineTransitionSchema,
  timelineNoteSchema,
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const conversationDetailSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  state: conversationStateSchema,
  holder: person.nullable(),
  customer: customerSummarySchema.extend({ firstSeenAt: z.iso.datetime({ offset: true }) }),
  channel: z.object({
    displayPhoneNumber: z.string(),
    /** The approved template that reopens the window, in the customer's language if there is one. */
    reopenTemplate: z.object({ name: z.string(), language: z.string() }).nullable(),
  }),
  windowClosesAt: z.iso.datetime({ offset: true }).nullable(),
  /** The business sends voice replies (tenant setting); the composer offers one. */
  voiceReplies: z.boolean(),
  timeline: z.array(timelineEntrySchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// --- request bodies ---------------------------------------------------------------

export const replyBodySchema = z.union([
  z.strictObject({
    text: z.string().trim().min(1).max(4096),
    /** Speak it as a voice note (Polly); it goes as text if it cannot be spoken. */
    voice: z.boolean().optional(),
  }),
  /** Outside the 24-hour window: the channel's approved reopen template. */
  z.strictObject({ template: z.literal('reopen') }),
]);
export type ReplyBody = z.infer<typeof replyBodySchema>;

export const noteBodySchema = z.strictObject({ text: z.string().trim().min(1).max(2000) });
export type NoteBody = z.infer<typeof noteBodySchema>;

export const assignBodySchema = z.strictObject({ userId: z.uuid() });
export type AssignBody = z.infer<typeof assignBodySchema>;

// --- live updates -------------------------------------------------------------------

/** Socket.IO path, under /api so the same proxy rule covers it. */
export const INBOX_SOCKET_PATH = '/api/socket.io';
/** The only event the inbox socket sends: refetch this conversation. */
export const INBOX_EVENT = 'conversation.changed';
export const inboxEventSchema = z.object({ conversationId: z.uuid() });
export type InboxEvent = z.infer<typeof inboxEventSchema>;
