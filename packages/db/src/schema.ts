import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
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

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  /** Counter for conversations.number; taken under the tenant row's lock. */
  nextConversationNumber: integer('next_conversation_number').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
    /** Approved template used to reopen a conversation after the 24-hour window. */
    reopenTemplateName: text('reopen_template_name'),
    createdAt: createdAt(),
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
    templateName: text('template_name'),
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
