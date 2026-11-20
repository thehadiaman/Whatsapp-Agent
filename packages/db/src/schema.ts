import type { OpeningHours } from '@app/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identity (Better Auth). Not tenant-owned: a user exists before and outside
// any tenant. Column set matches what Better Auth 1.7 expects (getAuthTables).
// ---------------------------------------------------------------------------

export const platformRole = pgEnum('platform_role', ['admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  platformRole: platformRole('platform_role'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Tenancy. Every table below is tenant-owned and protected by row-level
// security (see migrations/0001_row_level_security.sql).
// ---------------------------------------------------------------------------

export const tenantRole = pgEnum('tenant_role', ['owner', 'agent']);

/** How the assistant writes (system prompt). */
export const assistantTone = pgEnum('assistant_tone', ['warm', 'brief', 'formal']);

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    /** Counter for conversations.number; taken under the tenant row's lock. */
    nextConversationNumber: integer('next_conversation_number').notNull().default(1),
    /** What the business sells and where, in the owner's words. Defines "on topic" for the assistant. */
    assistantSummary: text('assistant_summary').notNull().default(''),
    /** Model tokens (in + out) the assistant may use per local day; then it hands over. */
    assistantDailyTokenBudget: integer('assistant_daily_token_budget').notNull().default(300_000),
    /** Assistant turns per customer per hour; more is treated as spam and goes to a person. */
    assistantTurnsPerCustomerHour: integer('assistant_turns_per_customer_hour')
      .notNull()
      .default(20),
    /** Languages customers speak to this business (en, hi, ml, ar): voice notes are transcribed as one of these. */
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    /** Answer a voice note with a voice note, where Polly has a voice for the language. */
    voiceReplies: boolean('voice_replies').notNull().default(false),
    /** Weekly opening hours in the tenant's time zone; null until the owner sets them. */
    openingHours: jsonb('opening_hours').$type<OpeningHours>(),
    assistantTone: assistantTone('assistant_tone').notNull().default('warm'),
    /** Words that always send a conversation to a person, in any language the owner writes. */
    escalationKeywords: text('escalation_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Assistant replies allowed in one conversation before a person takes it; null for no limit. */
    maxAssistantReplies: integer('max_assistant_replies'),
    /** On handover outside opening hours, tell the customer when a person will reply. */
    outsideHoursNotice: boolean('outside_hours_notice').notNull().default(true),
    /** Approved "reopen conversation" template name per language (P-05). */
    reopenTemplates: jsonb('reopen_templates')
      .$type<Partial<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'tenants_max_assistant_replies_range',
      sql`${t.maxAssistantReplies} is null or ${t.maxAssistantReplies} between 1 and 50`,
    ),
    check(
      'tenants_languages_known',
      sql`cardinality(${t.languages}) between 1 and 4 and ${t.languages} <@ array['en', 'hi', 'ml', 'ar']::text[]`,
    ),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // v1: a person works for one business. Unique, so a session maps to exactly one tenant.
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: tenantRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

/** Append-only record of ownership and settings changes (brief §7). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// WhatsApp pipeline (phase 2). All tenant-owned and protected by row-level
// security, except webhook_events and dead_letters (see 0003 migration).
// ---------------------------------------------------------------------------

/**
 * Where a business number's API lives. `simulator` channels talk to the local
 * simulator, `meta` channels to graph.facebook.com. Product code is identical;
 * only the base URL and secrets differ (brief §5, decision P-01).
 */
export const channelProvider = pgEnum('channel_provider', ['meta', 'simulator']);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: channelProvider('provider').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    displayPhoneNumber: text('display_phone_number').notNull(),
    /** Meta channels (P-04): the WhatsApp Business Account the number belongs to. */
    wabaId: text('waba_id'),
    /** Meta channels: the system-user access token, AES-256-GCM sealed (D-094). Never sent to a browser. */
    accessTokenSealed: text('access_token_sealed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('channels_provider_phone_number_id_unique').on(t.provider, t.phoneNumberId),
    index('channels_tenant_idx').on(t.tenantId),
  ],
);

/**
 * A WhatsApp user, as seen by one business. The business-scoped user ID
 * (BSUID) is the primary identity; Meta omits the phone number for users who
 * adopted a username, so either may be missing, but not both.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bsuid: text('bsuid'),
    waId: text('wa_id'),
    profileName: text('profile_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customers_tenant_bsuid_unique').on(t.tenantId, t.bsuid),
    unique('customers_tenant_wa_id_unique').on(t.tenantId, t.waId),
    check('customers_has_identity', sql`${t.bsuid} is not null or ${t.waId} is not null`),
  ],
);

/** Exactly one holder at a time (brief §4). */
export const conversationState = pgEnum('conversation_state', [
  'assistant',
  'waiting_for_human',
  'human',
  'closed',
]);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Per-business number shown as the conversation's token, e.g. 047. */
    number: integer('number').notNull(),
    state: conversationState('state').notNull().default('assistant'),
    /** The person holding the conversation when state is `human`. */
    holderUserId: uuid('holder_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Opens or resets the 24-hour customer service window. */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /** Next outbound sequence number; replies are sent strictly in this order. */
    nextOutboxSeq: bigint('next_outbox_seq', { mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one open conversation per customer and number.
    uniqueIndex('conversations_one_open_idx')
      .on(t.channelId, t.customerId)
      .where(sql`${t.state} <> 'closed'`),
    index('conversations_tenant_last_message_idx').on(t.tenantId, t.lastMessageAt),
    // Analytics count conversations by when they started.
    index('conversations_tenant_created_idx').on(t.tenantId, t.createdAt),
    unique('conversations_tenant_number_unique').on(t.tenantId, t.number),
  ],
);

/** Staff-only notes on a conversation: never sent to the customer. */
export const conversationNotes = pgTable(
  'conversation_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('conversation_notes_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const actorType = pgEnum('actor_type', ['system', 'assistant', 'user']);

/** Every change of holder, with who made it and why (brief §4). Append-only. */
export const conversationTransitions = pgTable(
  'conversation_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fromState: conversationState('from_state'),
    toState: conversationState('to_state').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [index('conversation_transitions_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageKind = pgEnum('message_kind', [
  'text',
  'image',
  'document',
  'audio',
  'template',
  'unsupported',
]);
export const senderType = pgEnum('sender_type', ['customer', 'assistant', 'user']);
export const messageStatus = pgEnum('message_status', [
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

export interface StoredMedia {
  /** Meta (or simulator) media ID. */
  id: string;
  mimeType: string;
  sha256: string | null;
  caption: string | null;
  filename?: string | null;
  voice?: boolean;
  /** Set once the file is copied into object storage: `tenants/{tenantId}/media/{messageId}`. */
  storageKey?: string;
  sizeBytes?: number;
  /** Audio length, read from an Ogg Opus file when it is stored. */
  durationMs?: number;
}

export type StoredTranscript =
  | { status: 'pending' }
  | {
      status: 'done';
      text: string;
      language: string;
      /** Which speech-to-text produced it: `transcribe` or `simulator`. */
      engine: string;
      confidence: number | null;
    }
  | { status: 'failed'; reason: string };

/** Why a reply that was meant to be spoken went as text. */
export type SpeechFallback = 'no_voice' | 'too_long' | 'too_large' | 'synthesis_failed';

export interface StoredSpeech {
  /** The reply's spoken language: en, hi, ml or ar. */
  language: string;
  /** Polly voice ID; null when the language has no voice. */
  voiceId: string | null;
  fallback: SpeechFallback | null;
  /** Text-to-speech engine that made the audio (`polly` or `mock`), once it has. */
  engine?: string;
  durationMs?: number;
}

export interface StoredError {
  code: number | null;
  message: string;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    kind: messageKind('kind').notNull(),
    senderType: senderType('sender_type').notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** WhatsApp message ID (wamid). Null for outbound messages not yet accepted by the API. */
    waMessageId: text('wa_message_id'),
    body: text('body'),
    media: jsonb('media').$type<StoredMedia>(),
    /** Inbound audio only: the speech-to-text result. */
    transcript: jsonb('transcript').$type<StoredTranscript>(),
    /** Outbound replies asked to be spoken: which voice, or why they went as text. */
    speech: jsonb('speech').$type<StoredSpeech>(),
    templateName: text('template_name'),
    /** WhatsApp template language code (`en`, `ar`, `hi`, `ml`). */
    templateLanguage: text('template_language'),
    status: messageStatus('status').notNull(),
    statusAt: timestamp('status_at', { withTimezone: true }).notNull().defaultNow(),
    error: jsonb('error').$type<StoredError>(),
    /** Outbound only: position in the conversation's send order. */
    outboxSeq: bigint('outbox_seq', { mode: 'number' }),
    attempts: integer('attempts').notNull().default(0),
    /** When WhatsApp says the message was sent (inbound) or when we sent it (outbound). */
    waTimestamp: timestamp('wa_timestamp', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Deduplication: the same WhatsApp message can never be stored twice (brief §4).
    unique('messages_channel_wa_message_id_unique').on(t.channelId, t.waMessageId),
    unique('messages_conversation_outbox_seq_unique').on(t.conversationId, t.outboxSeq),
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('messages_outbound_queued_idx')
      .on(t.status, t.createdAt)
      .where(sql`${t.direction} = 'outbound'`),
  ],
);

/**
 * Status webhooks (sent, delivered, read, played, failed), kept even when they
 * arrive before we know the message (e.g. before the send call returns).
 * The message's status is derived from them and never moves backwards.
 */
export const messageStatusEvents = pgTable(
  'message_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    waMessageId: text('wa_message_id').notNull(),
    status: text('status').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    errors: jsonb('errors'),
    createdAt: createdAt(),
  },
  (t) => [unique('message_status_events_dedupe').on(t.channelId, t.waMessageId, t.status)],
);

/**
 * Raw webhook POSTs, stored before anything else happens so a 200 can be
 * returned at once and nothing is lost if processing fails. Platform-level:
 * the tenant is not known until the payload is routed.
 */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: channelProvider('provider').notNull(),
  body: text('body').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  lastError: text('last_error'),
});

/** Jobs that will not succeed by retrying. Visible to platform admins only. */
export const deadLetters = pgTable('dead_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  queue: text('queue').notNull(),
  reference: text('reference').notNull(),
  reason: text('reason').notNull(),
  attempts: integer('attempts').notNull(),
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Knowledge base and assistant (phase 4)
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const knowledgeSourceKind = pgEnum('knowledge_source_kind', ['faq', 'file', 'catalogue']);
export const knowledgeSourceStatus = pgEnum('knowledge_source_status', [
  'queued',
  'reading',
  'ready',
  'failed',
]);

/** One thing the owner added: an FAQ entry, an uploaded document, or a product catalogue. */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: knowledgeSourceKind('kind').notNull(),
    /** File name, or the FAQ question. */
    title: text('title').notNull(),
    /** FAQ only. */
    answer: text('answer'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    /** Files only: `tenants/{tenantId}/knowledge/{sourceId}`. */
    storageKey: text('storage_key'),
    status: knowledgeSourceStatus('status').notNull().default('queued'),
    /** Why reading failed and what to do, in words the owner can act on. */
    error: text('error'),
    passageCount: integer('passage_count').notNull().default(0),
    /** Pages or rows; shown as "6 pages" or "212 products". */
    unitCount: integer('unit_count'),
    /** Bumped on every edit or re-upload; passages carry the version they came from. */
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('knowledge_sources_tenant_idx').on(t.tenantId, t.createdAt)],
);

/**
 * Retrievable passages. Exact nearest-neighbour search (no ANN index): a
 * business has hundreds to a few thousand passages, which Postgres scans in
 * milliseconds, and an approximate index would filter out tenants' rows after
 * the search and return too few (D-062).
 */
export const knowledgePassages = pgTable(
  'knowledge_passages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    /** Keyword half of hybrid search: product names, order numbers, words in any script. */
    search: tsvector('search')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', coalesce(heading, '') || ' ' || text)`),
    createdAt: createdAt(),
  },
  (t) => [
    index('knowledge_passages_tenant_idx').on(t.tenantId),
    unique('knowledge_passages_source_ordinal_unique').on(t.sourceId, t.ordinal),
    index('knowledge_passages_search_idx').using('gin', t.search),
  ],
);

export const orderStatus = pgEnum('order_status', [
  'received',
  'preparing',
  'ready',
  'shipped',
  'delivered',
  'cancelled',
]);

export interface OrderItem {
  name: string;
  quantity: number;
}

/** Orders as the business's own system knows them; `lookup_order` reads these. */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Who placed it. The assistant shows an order only to this customer. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    orderNumber: text('order_number').notNull(),
    status: orderStatus('status').notNull(),
    items: jsonb('items').$type<OrderItem[]>().notNull().default([]),
    total: numeric('total', { precision: 12, scale: 2 }),
    currency: text('currency'),
    courier: text('courier'),
    trackingNumber: text('tracking_number'),
    /** Null means no date was promised; the assistant must then say so, not guess. */
    promisedDate: date('promised_date'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('orders_tenant_number_unique').on(t.tenantId, t.orderNumber)],
);

export const assistantOutcome = pgEnum('assistant_outcome', [
  'replied',
  'handed_off',
  'declined',
  'guard_blocked',
  'budget_exhausted',
  'rate_limited',
  'skipped',
  'failed',
]);

export interface TurnPassage {
  passageId: string;
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  score: number;
}

export interface TurnToolCall {
  name: string;
  input: unknown;
  result: unknown;
}

/** One assistant turn: what it read, what it called, what it cost (brief §4, "Explain this reply"). */
export const assistantTurns = pgTable(
  'assistant_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** The newest customer message this turn answered. One turn per message, so a retry is a no-op. */
    triggerMessageId: uuid('trigger_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    replyMessageId: uuid('reply_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    model: text('model').notNull(),
    outcome: assistantOutcome('outcome').notNull(),
    /** knowledge, order, none or declined, as the model reported it. */
    basis: text('basis'),
    language: text('language'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    modelCalls: integer('model_calls').notNull().default(0),
    passages: jsonb('passages').$type<TurnPassage[]>().notNull().default([]),
    toolCalls: jsonb('tool_calls').$type<TurnToolCall[]>().notNull().default([]),
    /** Why a guard stopped the reply, or what failed. Never message text. */
    detail: text('detail'),
    /** Why the conversation went to a person, as a code for analytics; null if it did not. */
    handoffReason: text('handoff_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('assistant_turns_trigger_unique').on(t.triggerMessageId),
    index('assistant_turns_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('assistant_turns_customer_created_idx').on(t.customerId, t.createdAt),
    index('assistant_turns_reply_idx').on(t.replyMessageId),
  ],
);

/** Tokens and cost per business per local day; the daily budget is checked against it. */
export const assistantUsageDaily = pgTable(
  'assistant_usage_daily',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    turns: integer('turns').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.day] })],
);

// ---------------------------------------------------------------------------
// Staff accounts without email (P-03): an owner hands over a link.
// Tokens are stored as SHA-256 hashes; the link carries the token itself.
// ---------------------------------------------------------------------------

export const staffInvites = pgTable(
  'staff_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: tenantRole('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('staff_invites_tenant_idx').on(t.tenantId)],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('password_resets_tenant_idx').on(t.tenantId)],
);
