import { z } from 'zod';

/**
 * Meta WhatsApp Cloud API webhook payloads (Graph API v26.0), checked against
 * Meta's webhook reference on 2026-11-17. Parsing is strict about what we rely
 * on and lenient about everything else (`loose`), because Meta adds fields.
 *
 * Identity: `from_user_id` / `user_id` (business-scoped user ID, BSUID) is the
 * primary key. `from` / `wa_id` (phone number) may be omitted for users with a
 * username, so both are optional here.
 */

const mediaSchema = z
  .object({
    id: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    url: z.string().optional(),
    caption: z.string().optional(),
  })
  .loose();

const errorSchema = z
  .object({
    code: z.number(),
    title: z.string().optional(),
    message: z.string().optional(),
    error_data: z.object({ details: z.string().optional() }).loose().optional(),
  })
  .loose();
export type WebhookError = z.infer<typeof errorSchema>;

const inboundMessageSchema = z
  .object({
    id: z.string(),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string(),
    from: z.string().optional(),
    from_user_id: z.string().optional(),
    context: z.object({ id: z.string().optional() }).loose().optional(),
    text: z.object({ body: z.string() }).loose().optional(),
    image: mediaSchema.optional(),
    document: mediaSchema.extend({ filename: z.string().optional() }).optional(),
    audio: mediaSchema.extend({ voice: z.boolean().optional() }).optional(),
    errors: z.array(errorSchema).optional(),
  })
  .loose()
  .refine((m) => m.from !== undefined || m.from_user_id !== undefined, {
    message: 'message has neither from nor from_user_id',
  });
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string().regex(/^\d+$/),
    recipient_id: z.string().optional(),
    recipient_user_id: z.string().optional(),
    errors: z.array(errorSchema).optional(),
  })
  .loose();
export type WebhookStatus = z.infer<typeof statusSchema>;

const contactSchema = z
  .object({
    profile: z
      .object({ name: z.string().optional(), username: z.string().optional() })
      .loose()
      .optional(),
    wa_id: z.string().optional(),
    user_id: z.string().optional(),
  })
  .loose();

export const messagesValueSchema = z
  .object({
    messaging_product: z.literal('whatsapp'),
    metadata: z.object({ display_phone_number: z.string(), phone_number_id: z.string() }).loose(),
    contacts: z.array(contactSchema).optional(),
    messages: z.array(inboundMessageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
    errors: z.array(errorSchema).optional(),
  })
  .loose();
export type MessagesValue = z.infer<typeof messagesValueSchema>;

export const webhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() }).loose()),
    }),
  ),
});

/** Every `messages`-field change in a payload, parsed. Other fields are ignored. */
export function messagesValues(payload: unknown): MessagesValue[] {
  const parsed = webhookPayloadSchema.parse(payload);
  return parsed.entry.flatMap((entry) =>
    entry.changes
      .filter((change) => change.field === 'messages')
      .map((change) => messagesValueSchema.parse(change.value)),
  );
}

export interface MediaRef {
  id: string;
  mimeType: string;
  sha256: string | null;
  caption: string | null;
}

/** What the product stores for an inbound message, independent of Meta's shape. */
export type InboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'image'; media: MediaRef }
  | { kind: 'document'; media: MediaRef; filename: string | null }
  | { kind: 'audio'; media: MediaRef; voice: boolean }
  | { kind: 'unsupported'; type: string };

function mediaRef(m: z.infer<typeof mediaSchema>): MediaRef {
  return { id: m.id, mimeType: m.mime_type, sha256: m.sha256 ?? null, caption: m.caption ?? null };
}

export function inboundContent(message: InboundMessage): InboundContent {
  if (message.type === 'text' && message.text) return { kind: 'text', body: message.text.body };
  if (message.type === 'image' && message.image) {
    return { kind: 'image', media: mediaRef(message.image) };
  }
  if (message.type === 'document' && message.document) {
    return {
      kind: 'document',
      media: mediaRef(message.document),
      filename: message.document.filename ?? null,
    };
  }
  if (message.type === 'audio' && message.audio) {
    return { kind: 'audio', media: mediaRef(message.audio), voice: message.audio.voice ?? false };
  }
  return { kind: 'unsupported', type: message.type };
}

/** The display name Meta sent for a customer, matched by BSUID first, then phone. */
export function contactName(
  value: MessagesValue,
  ids: { bsuid: string | null; waId: string | null },
): string | null {
  const contact = value.contacts?.find(
    (c) =>
      (ids.bsuid !== null && c.user_id === ids.bsuid) ||
      (ids.waId !== null && c.wa_id === ids.waId),
  );
  return contact?.profile?.name ?? null;
}

/** Meta timestamps are Unix seconds as strings. */
export function webhookTime(timestamp: string): Date {
  return new Date(Number(timestamp) * 1000);
}
