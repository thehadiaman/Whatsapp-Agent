import { schema, withTenant, type Database, type Transaction } from '@app/db';
import {
  contactName,
  inboundContent,
  messagesValues,
  webhookTime,
  type InboundMessage,
  type MessagesValue,
  type WebhookStatus,
} from '@app/whatsapp';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Provider } from './config.js';
import { recordDeadLetter } from './dead-letters.js';
import type { PipelineDeps } from './deps.js';
import { enqueueAssistant, enqueueMedia, QUEUES, type AssistantJob } from './queues.js';
import { isWebhookStatus } from './rules.js';
import { applyStatusEvents } from './statuses.js';

interface Route {
  channelId: string;
  tenantId: string;
}

async function routeChannel(
  db: Database,
  provider: Provider,
  phoneNumberId: string,
): Promise<Route | null> {
  const result = await db.execute<{ channel_id: string; tenant_id: string }>(
    sql`select channel_id, tenant_id from channel_route(${provider}, ${phoneNumberId})`,
  );
  const row = result.rows[0];
  return row ? { channelId: row.channel_id, tenantId: row.tenant_id } : null;
}

export interface ProcessResult {
  inboundMessageIds: string[];
  duplicates: number;
}

/**
 * Turns one stored webhook POST into customers, conversations, messages and
 * status updates. Idempotent: processing the same event twice, or the same
 * WhatsApp message in two events, stores it once (unique constraint on
 * channel + wamid). Each tenant's part runs in its own tenant-scoped
 * transaction, so a payload can never write into the wrong tenant.
 */
export async function processWebhookEvent(
  deps: PipelineDeps,
  eventId: string,
): Promise<ProcessResult> {
  const result: ProcessResult = { inboundMessageIds: [], duplicates: 0 };
  const [event] = await deps.db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, eventId));
  if (!event || event.processedAt) return result;

  let values: MessagesValue[];
  try {
    values = messagesValues(JSON.parse(event.body));
  } catch (error) {
    // A malformed payload will not parse better on retry.
    const reason = `malformed webhook payload: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`;
    await markProcessed(deps.db, eventId, reason);
    await recordDeadLetter(deps.db, {
      tenantId: null,
      queue: QUEUES.webhooks,
      reference: eventId,
      reason,
      attempts: 1,
    });
    return result;
  }

  const mediaJobs: { tenantId: string; messageId: string }[] = [];
  const assistantJobs: AssistantJob[] = [];
  const changed: { tenantId: string; conversationId: string }[] = [];
  for (const value of values) {
    const phoneNumberId = value.metadata.phone_number_id;
    const route = await routeChannel(deps.db, event.provider, phoneNumberId);
    if (!route) {
      deps.logger.warn({ eventId, phoneNumberId }, 'webhook for unknown phone number');
      await recordDeadLetter(deps.db, {
        tenantId: null,
        queue: QUEUES.webhooks,
        reference: eventId,
        reason: `no channel for ${event.provider} phone number ID ${phoneNumberId}`,
        attempts: 1,
      });
      continue;
    }

    await withTenant(deps.db, route.tenantId, async (tx) => {
      for (const message of value.messages ?? []) {
        const stored = await storeInbound(tx, route, value, message);
        // Duplicates are queued too: if a crash came between an earlier commit
        // and its enqueue, Meta's retry is what gets the customer an answer.
        // The job ID and the turn's unique trigger make a repeat a no-op.
        assistantJobs.push({
          tenantId: route.tenantId,
          conversationId: stored.conversationId,
          messageId: stored.id,
        });
        if (stored.duplicate) {
          result.duplicates += 1;
          continue;
        }
        result.inboundMessageIds.push(stored.id);
        changed.push({ tenantId: route.tenantId, conversationId: stored.conversationId });
        if (stored.hasMedia) mediaJobs.push({ tenantId: route.tenantId, messageId: stored.id });
      }
      for (const status of value.statuses ?? []) {
        const conversationId = await storeStatus(tx, route, status);
        if (conversationId) changed.push({ tenantId: route.tenantId, conversationId });
      }
    });
    if (value.errors?.length) {
      deps.logger.warn(
        { eventId, codes: value.errors.map((e) => e.code) },
        'webhook carried account or app errors',
      );
    }
  }

  // After commit: the rows exist before any job can look for them.
  for (const job of mediaJobs) await enqueueMedia(deps.queues, job);
  if (deps.assistant.settings.enabled) {
    for (const job of assistantJobs) {
      await enqueueAssistant(deps.queues, job, deps.assistant.settings.debounceMs);
    }
  }
  const unique = new Map(changed.map((c) => [c.conversationId, c]));
  for (const c of unique.values())
    await deps.events.conversationChanged(c.tenantId, c.conversationId);
  await markProcessed(deps.db, eventId, null);
  deps.logger.info(
    { eventId, stored: result.inboundMessageIds.length, duplicates: result.duplicates },
    'webhook processed',
  );
  return result;
}

async function markProcessed(db: Database, eventId: string, error: string | null): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({ processedAt: new Date(), lastError: error })
    .where(eq(schema.webhookEvents.id, eventId));
}

async function upsertCustomer(
  tx: Transaction,
  tenantId: string,
  identity: { bsuid: string | null; waId: string | null; name: string | null },
): Promise<string> {
  const find = async () => {
    if (identity.bsuid) {
      const [byBsuid] = await tx
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(eq(schema.customers.bsuid, identity.bsuid));
      if (byBsuid) return byBsuid.id;
    }
    if (identity.waId) {
      const [byPhone] = await tx
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(eq(schema.customers.waId, identity.waId));
      if (byPhone) return byPhone.id;
    }
    return null;
  };

  const existing = await find();
  if (existing) {
    // Fill in whichever identifier we learn later (e.g. BSUID for a phone-only customer).
    await tx
      .update(schema.customers)
      .set({
        ...(identity.bsuid ? { bsuid: identity.bsuid } : {}),
        ...(identity.waId ? { waId: identity.waId } : {}),
        ...(identity.name ? { profileName: identity.name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.customers.id, existing));
    return existing;
  }

  const [inserted] = await tx
    .insert(schema.customers)
    .values({ tenantId, bsuid: identity.bsuid, waId: identity.waId, profileName: identity.name })
    .onConflictDoNothing()
    .returning({ id: schema.customers.id });
  if (inserted) return inserted.id;
  // A concurrent event created the customer first.
  const raced = await find();
  if (!raced) throw new Error('customer upsert: conflict but no row found');
  return raced;
}

async function openConversation(
  tx: Transaction,
  route: Route,
  customerId: string,
): Promise<string> {
  const findOpen = () =>
    tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.channelId, route.channelId),
          eq(schema.conversations.customerId, customerId),
          ne(schema.conversations.state, 'closed'),
        ),
      );

  const [open] = await findOpen();
  if (open) return open.id;

  // The tenant row's lock serialises numbering; a lost race below leaves a gap, which is harmless.
  const [counter] = await tx
    .update(schema.tenants)
    .set({ nextConversationNumber: sql`${schema.tenants.nextConversationNumber} + 1` })
    .where(eq(schema.tenants.id, route.tenantId))
    .returning({ next: schema.tenants.nextConversationNumber });
  if (!counter) throw new Error('openConversation: tenant not visible');

  const [created] = await tx
    .insert(schema.conversations)
    .values({
      tenantId: route.tenantId,
      channelId: route.channelId,
      customerId,
      number: counter.next - 1,
    })
    .onConflictDoNothing({
      target: [schema.conversations.channelId, schema.conversations.customerId],
      where: sql`state <> 'closed'`,
    })
    .returning({ id: schema.conversations.id });
  if (!created) {
    const [raced] = await findOpen();
    if (!raced) throw new Error('conversation upsert: conflict but no row found');
    return raced.id;
  }
  await tx.insert(schema.conversationTransitions).values({
    tenantId: route.tenantId,
    conversationId: created.id,
    fromState: null,
    toState: 'assistant',
    actorType: 'system',
    reason: 'Customer started a conversation',
  });
  return created.id;
}

async function storeInbound(
  tx: Transaction,
  route: Route,
  value: MessagesValue,
  message: InboundMessage,
): Promise<{ id: string; conversationId: string; hasMedia: boolean; duplicate: boolean }> {
  const bsuid = message.from_user_id ?? null;
  const waId = message.from ?? null;
  const customerId = await upsertCustomer(tx, route.tenantId, {
    bsuid,
    waId,
    name: contactName(value, { bsuid, waId }),
  });
  const conversationId = await openConversation(tx, route, customerId);
  const content = inboundContent(message);
  const sentAt = webhookTime(message.timestamp);

  const [inserted] = await tx
    .insert(schema.messages)
    .values({
      tenantId: route.tenantId,
      channelId: route.channelId,
      conversationId,
      direction: 'inbound',
      kind: content.kind,
      senderType: 'customer',
      waMessageId: message.id,
      body:
        content.kind === 'text' ? content.body : 'media' in content ? content.media.caption : null,
      media:
        'media' in content
          ? {
              ...content.media,
              ...(content.kind === 'document' ? { filename: content.filename } : {}),
              ...(content.kind === 'audio' ? { voice: content.voice } : {}),
            }
          : null,
      // A voice note waits for its transcript before the assistant answers.
      transcript: content.kind === 'audio' ? { status: 'pending' } : null,
      status: 'received',
      statusAt: sentAt,
      waTimestamp: sentAt,
    })
    .onConflictDoNothing({ target: [schema.messages.channelId, schema.messages.waMessageId] })
    .returning({ id: schema.messages.id });
  if (!inserted) {
    const [existing] = await tx
      .select({ id: schema.messages.id, conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, route.channelId),
          eq(schema.messages.waMessageId, message.id),
        ),
      );
    if (!existing) throw new Error('inbound dedupe: conflict but no row found');
    return { ...existing, hasMedia: false, duplicate: true };
  }

  // Out-of-order delivery: an older message arriving late must not move the
  // window or "last message" time backwards.
  await tx
    .update(schema.conversations)
    .set({
      lastInboundAt: sql`greatest(${schema.conversations.lastInboundAt}, ${sentAt.toISOString()}::timestamptz)`,
      lastMessageAt: sql`greatest(${schema.conversations.lastMessageAt}, ${sentAt.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, conversationId));

  return { id: inserted.id, conversationId, hasMedia: 'media' in content, duplicate: false };
}

async function storeStatus(
  tx: Transaction,
  route: Route,
  status: WebhookStatus,
): Promise<string | null> {
  if (!isWebhookStatus(status.status)) return null;
  await tx
    .insert(schema.messageStatusEvents)
    .values({
      tenantId: route.tenantId,
      channelId: route.channelId,
      waMessageId: status.id,
      status: status.status,
      occurredAt: webhookTime(status.timestamp),
      errors: status.errors ?? null,
    })
    .onConflictDoNothing();
  return applyStatusEvents(tx, route.channelId, status.id);
}
