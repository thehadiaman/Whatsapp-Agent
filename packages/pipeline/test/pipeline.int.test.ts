import { schema, withTenant } from '@app/db';
import { statusPayload } from '@app/simulator';
import { and, eq, isNull, like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { transitionConversation } from '../src/conversations.js';
import { ingestWebhook } from '../src/ingest.js';
import { queueReply, WindowClosedError } from '../src/outbound.js';
import { enqueueOutbound } from '../src/queues.js';
import { startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h.close();
});

async function inbound(tenantId: string) {
  return h.migrator.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.direction, 'inbound')));
}

async function conversationOf(bsuid: string) {
  const [row] = await h.migrator.db
    .select({ conversation: schema.conversations })
    .from(schema.conversations)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
    .where(eq(schema.customers.bsuid, bsuid));
  if (!row) throw new Error('no conversation');
  return row.conversation;
}

async function message(id: string) {
  const [row] = await h.migrator.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  if (!row) throw new Error('no message');
  return row;
}

/** A customer writes, then the agent takes the conversation over. */
async function openForAgent(customerIndex = 0) {
  const customer = h.customers[customerIndex]!;
  h.sim.sendInbound([{ customerId: customer.id, type: 'text', text: 'Hello' }]);
  await waitFor('inbound stored', async () => (await inbound(h.tenant.id)).length > customerIndex);
  const conversation = await conversationOf(customer.bsuid);
  await withTenant(h.deps.db, h.tenant.id, (tx) =>
    transitionConversation(tx, {
      conversationId: conversation.id,
      to: 'human',
      actor: { type: 'user', userId: h.tenant.agentId },
      reason: 'test',
    }),
  );
  return { customer, conversation };
}

async function reply(conversationId: string, text: string, enqueue = true) {
  const id = await withTenant(h.deps.db, h.tenant.id, (tx) =>
    queueReply(tx, {
      conversationId,
      sender: { type: 'user', userId: h.tenant.agentId },
      content: { kind: 'text', body: text },
      now: new Date(),
    }),
  );
  if (enqueue) await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
  return id;
}

describe('inbound', () => {
  it('stores each WhatsApp message once despite duplicate deliveries', async () => {
    h = await startHarness({ faults: { duplicateRate: 1 } });
    h.sim.sendInbound([
      { customerId: h.customers[0]!.id, type: 'text', text: 'one' },
      { customerId: h.customers[1]!.id, type: 'text', text: 'two' },
    ]);
    await h.sim.idle();
    await waitFor('both processed', async () => (await inbound(h.tenant.id)).length === 2);
    // Every webhook arrived twice; wait until both copies have been processed.
    await waitFor('all events processed', async () => {
      const events = await h.migrator.db
        .select({ processedAt: schema.webhookEvents.processedAt })
        .from(schema.webhookEvents)
        .where(like(schema.webhookEvents.body, `%${h.tenant.phoneNumberId}%`));
      return events.length === 2 && events.every((e) => e.processedAt !== null);
    });
    const unprocessed = await h.migrator.db
      .select()
      .from(schema.webhookEvents)
      .where(
        and(
          isNull(schema.webhookEvents.processedAt),
          like(schema.webhookEvents.body, `%${h.tenant.phoneNumberId}%`),
        ),
      );
    expect(unprocessed).toHaveLength(0);
    expect(h.sim.dispatcher.delivered).toBe(2);
    expect(await inbound(h.tenant.id)).toHaveLength(2);
  });

  it('identifies a username-only customer by BSUID and opens one conversation', async () => {
    h = await startHarness();
    const usernameOnly = h.customers[2]!;
    expect(usernameOnly.waId).toBeNull();
    h.sim.sendInbound([
      { customerId: usernameOnly.id, type: 'text', text: 'first' },
      { customerId: usernameOnly.id, type: 'text', text: 'second' },
    ]);
    await waitFor('stored', async () => (await inbound(h.tenant.id)).length === 2);
    const customers = await h.migrator.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.tenantId, h.tenant.id));
    expect(customers).toEqual([
      expect.objectContaining({ bsuid: usernameOnly.bsuid, waId: null, profileName: 'Customer 3' }),
    ]);
    const conversations = await h.migrator.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.tenantId, h.tenant.id));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.state).toBe('assistant');
  });

  it('opens the 24-hour window from the newest message even when an older one arrives last', async () => {
    h = await startHarness();
    const customer = h.customers[0]!;
    h.sim.sendInbound([{ customerId: customer.id, type: 'text', text: 'new' }]);
    await waitFor('first', async () => (await inbound(h.tenant.id)).length === 1);
    const before = (await conversationOf(customer.bsuid)).lastInboundAt;
    h.sim.sendInbound([
      { customerId: customer.id, type: 'text', text: 'old', ageMs: 60 * 60 * 1000 },
    ]);
    await waitFor('second', async () => (await inbound(h.tenant.id)).length === 2);
    expect((await conversationOf(customer.bsuid)).lastInboundAt).toEqual(before);
  });

  it('copies inbound media into tenant-prefixed storage', async () => {
    h = await startHarness();
    const bytes = Buffer.from('fake-jpeg-bytes');
    h.sim.sendInbound([
      {
        customerId: h.customers[0]!.id,
        type: 'image',
        caption: 'Cracked screen',
        dataBase64: bytes.toString('base64'),
        mimeType: 'image/jpeg',
      },
    ]);
    await waitFor('media stored', async () => {
      const [m] = await inbound(h.tenant.id);
      return Boolean(m?.media?.storageKey);
    });
    const [m] = await inbound(h.tenant.id);
    expect(m?.media?.storageKey).toBe(`tenants/${h.tenant.id}/media/${m!.id}`);
    expect(m?.body).toBe('Cracked screen');
    const stored = await h.deps.storage.get(m!.media!.storageKey!);
    expect(Buffer.from(stored!.bytes).toString()).toBe('fake-jpeg-bytes');
  });

  it('sends unroutable and malformed webhooks to the dead-letter table', async () => {
    h = await startHarness();
    const unknown = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1', phone_number_id: '999999999999999' },
                messages: [],
              },
            },
          ],
        },
      ],
    });
    const a = await ingestWebhook(h.deps.db, h.deps.queues, 'simulator', unknown);
    const b = await ingestWebhook(h.deps.db, h.deps.queues, 'simulator', '{"object":"page"}');
    await waitFor('dead letters', async () => {
      const rows = await h.migrator.db.select().from(schema.deadLetters);
      return rows.some((r) => r.reference === a) && rows.some((r) => r.reference === b);
    });
    const rows = await h.migrator.db.select().from(schema.deadLetters);
    expect(rows.find((r) => r.reference === a)?.reason).toContain('999999999999999');
    expect(rows.find((r) => r.reference === b)?.reason).toContain('malformed');
  });
});

describe('statuses', () => {
  it('ends at read whatever order sent, delivered and read arrive in', async () => {
    h = await startHarness({ statusStepMs: 60_000 }); // simulator statuses effectively off
    const { conversation, customer } = await openForAgent();
    const id = await reply(conversation.id, 'Your order shipped');
    await waitFor('sent', async () => (await message(id)).waMessageId !== null);
    const wamid = (await message(id)).waMessageId!;
    const business = h.sim.state.businesses.get(h.tenant.phoneNumberId)!;
    const simCustomer = h.sim.state.customers.get(customer.id)!;
    for (const status of ['read', 'delivered', 'sent'] as const) {
      await ingestWebhook(
        h.deps.db,
        h.deps.queues,
        'simulator',
        JSON.stringify(
          statusPayload(business, { customer: simCustomer, wamid, status, at: Date.now() }),
        ),
      );
    }
    await waitFor('read', async () => (await message(id)).status === 'read');
    // Late duplicates of earlier statuses change nothing.
    await ingestWebhook(
      h.deps.db,
      h.deps.queues,
      'simulator',
      JSON.stringify(
        statusPayload(business, {
          customer: simCustomer,
          wamid,
          status: 'delivered',
          at: Date.now(),
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect((await message(id)).status).toBe('read');
  });
});

describe('outbound', () => {
  it('sends a conversation’s replies in order, each once', async () => {
    h = await startHarness();
    const { conversation, customer } = await openForAgent();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await reply(conversation.id, `reply ${String(i)}`));
    await waitFor('all delivered', async () => {
      const statuses = await Promise.all(ids.map(async (id) => (await message(id)).status));
      return statuses.every((s) => s === 'delivered');
    });
    const out = h.sim.state.thread(customer.id).filter((m) => m.direction === 'out');
    expect(out.map((m) => m.text)).toEqual([1, 2, 3, 4, 5].map((i) => `reply ${String(i)}`));
  });

  it('retries failed and rate-limited sends without breaking order or duplicating', async () => {
    h = await startHarness({ faults: { failSendRate: 0.3, rateLimitRate: 0.2 }, seed: 11 });
    const { conversation, customer } = await openForAgent();
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await reply(conversation.id, `reply ${String(i)}`));
    await waitFor('all sent', async () => {
      const rows = await Promise.all(ids.map(message));
      return rows.every((r) => r.status === 'delivered');
    });
    const out = h.sim.state.thread(customer.id).filter((m) => m.direction === 'out');
    expect(out.map((m) => m.text)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `reply ${String(i)}`));
    const attempts = (await Promise.all(ids.map(message))).map((r) => r.attempts);
    expect(attempts.some((a) => a > 1)).toBe(true);
  });

  it('gives up after the last attempt: message failed, dead letter recorded', async () => {
    h = await startHarness({ outboundAttempts: 3 });
    const { conversation } = await openForAgent();
    h.sim.setFaults({ failSendRate: 1 });
    const id = await reply(conversation.id, 'will fail');
    await waitFor('failed', async () => (await message(id)).status === 'failed');
    const row = await message(id);
    expect(row.attempts).toBe(3);
    expect(row.error?.code).toBe(131000);
    const [dead] = await h.migrator.db
      .select()
      .from(schema.deadLetters)
      .where(eq(schema.deadLetters.reference, id));
    expect(dead?.reason).toContain('gave up after 3 attempts');
  });

  it('refuses free text once the 24-hour window has closed', async () => {
    h = await startHarness();
    const { conversation } = await openForAgent();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await h.migrator.db
      .update(schema.conversations)
      .set({ lastInboundAt: old })
      .where(eq(schema.conversations.id, conversation.id));

    // Refused when queued...
    await expect(reply(conversation.id, 'too late')).rejects.toBeInstanceOf(WindowClosedError);

    // ...and checked again at send time, without calling the API.
    await h.migrator.db
      .update(schema.conversations)
      .set({ lastInboundAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));
    const id = await reply(conversation.id, 'queued while open', false);
    await h.migrator.db
      .update(schema.conversations)
      .set({ lastInboundAt: old })
      .where(eq(schema.conversations.id, conversation.id));
    await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
    await waitFor('failed', async () => (await message(id)).status === 'failed');
    expect((await message(id)).error?.code).toBe(131047);
    expect((await message(id)).attempts).toBe(0);
  });

  it('cancels an assistant reply if a person takes over before it is sent', async () => {
    h = await startHarness();
    const customer = h.customers[0]!;
    h.sim.sendInbound([{ customerId: customer.id, type: 'text', text: 'Hi' }]);
    await waitFor('stored', async () => (await inbound(h.tenant.id)).length === 1);
    const conversation = await conversationOf(customer.bsuid);
    const id = await withTenant(h.deps.db, h.tenant.id, (tx) =>
      queueReply(tx, {
        conversationId: conversation.id,
        sender: { type: 'assistant' },
        content: { kind: 'text', body: 'assistant draft' },
        now: new Date(),
      }),
    );
    await withTenant(h.deps.db, h.tenant.id, (tx) =>
      transitionConversation(tx, {
        conversationId: conversation.id,
        to: 'human',
        actor: { type: 'user', userId: h.tenant.agentId },
        reason: 'test',
      }),
    );
    await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
    await waitFor('cancelled', async () => (await message(id)).status === 'cancelled');
    expect(h.sim.state.thread(customer.id).filter((m) => m.direction === 'out')).toHaveLength(0);
  });
});

describe('outbox recovery', () => {
  it('the sweeper sends a reply whose job was never enqueued', async () => {
    h = await startHarness();
    const { conversation, customer } = await openForAgent();
    // Committed to the outbox, but the enqueue "crashed".
    const id = await reply(conversation.id, 'recovered by the sweeper', false);
    await waitFor(
      'delivered via sweeper',
      async () => (await message(id)).status === 'delivered',
      15_000,
    );
    const out = h.sim.state.thread(customer.id).filter((m) => m.direction === 'out');
    expect(out.map((m) => m.text)).toEqual(['recovered by the sweeper']);
  });
});

describe('tenant isolation in background jobs', () => {
  it("a job naming tenant B cannot send or change tenant A's message", async () => {
    h = await startHarness();
    const { conversation, customer } = await openForAgent();
    const id = await reply(conversation.id, 'tenant A only', false);
    const other = await h.createTenant();

    await enqueueOutbound(h.deps.queues, { tenantId: other.id, messageId: id });
    await new Promise((r) => setTimeout(r, 1_000));

    const row = await message(id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(h.sim.state.thread(customer.id).filter((m) => m.direction === 'out')).toHaveLength(0);
  });

  it("a webhook for tenant A's number never writes into tenant B", async () => {
    h = await startHarness();
    const other = await h.createTenant();
    h.sim.sendInbound([{ customerId: h.customers[0]!.id, type: 'text', text: 'for A' }]);
    await waitFor('stored', async () => (await inbound(h.tenant.id)).length === 1);
    expect(await inbound(other.id)).toHaveLength(0);
  });
});
