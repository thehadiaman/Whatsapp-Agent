import { schema, withTenant } from '@app/db';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { transitionConversation } from '../src/conversations.js';
import { queueReply } from '../src/outbound.js';
import { enqueueOutbound } from '../src/queues.js';
import { startHarness, waitFor, type Harness } from './harness.js';

// Brief §5: fault injection must not lose or duplicate anything. This runs in
// CI on every push; the 1,000-message load test (phase 8) is the larger version.

const CUSTOMERS = 10;
const INBOUND_PER_CUSTOMER = 20;
const REPLIES_PER_CUSTOMER = 10;

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    customers: CUSTOMERS,
    seed: 2026,
    statusStepMs: 10,
    orderHoldMs: 150,
    outboundAttempts: 12,
    outboundBackoffMs: 10,
    faults: { duplicateRate: 0.3, reorderWindowMs: 200 },
  });
});

afterAll(async () => {
  await h.close();
});

async function count(where: ReturnType<typeof and>) {
  const [row] = await h.migrator.db
    .select({
      n: sql<number>`count(*)::int`,
      distinct: sql<number>`count(distinct wa_message_id)::int`,
    })
    .from(schema.messages)
    .where(where);
  return row ?? { n: 0, distinct: 0 };
}

it(`${String(CUSTOMERS * INBOUND_PER_CUSTOMER)} inbound messages with duplicates and reordering: none lost, none doubled`, async () => {
  for (let round = 1; round <= INBOUND_PER_CUSTOMER; round++) {
    h.sim.sendInbound(
      h.customers.map((c) => ({
        customerId: c.id,
        type: 'text' as const,
        text: `message ${String(round)}`,
      })),
    );
  }
  await h.sim.idle();
  const expected = CUSTOMERS * INBOUND_PER_CUSTOMER;
  const inbound = and(
    eq(schema.messages.tenantId, h.tenant.id),
    eq(schema.messages.direction, 'inbound'),
  );
  await waitFor(
    'every inbound event processed',
    async () => {
      const pending = await h.migrator.db
        .select({ id: schema.webhookEvents.id })
        .from(schema.webhookEvents)
        .where(
          and(
            isNull(schema.webhookEvents.processedAt),
            like(schema.webhookEvents.body, `%${h.tenant.phoneNumberId}%`),
          ),
        );
      return pending.length === 0 && (await count(inbound)).n >= expected;
    },
    60_000,
  );

  expect(h.sim.dispatcher.delivered).toBeGreaterThan(INBOUND_PER_CUSTOMER); // duplicates happened
  expect(await count(inbound)).toEqual({ n: expected, distinct: expected });
  const conversations = await h.migrator.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, h.tenant.id));
  expect(conversations).toHaveLength(CUSTOMERS);
}, 120_000);

it(`${String(CUSTOMERS * REPLIES_PER_CUSTOMER)} replies with failed sends, rate limits and duplicate statuses: each sent once, in order`, async () => {
  const conversations = await h.migrator.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, h.tenant.id));
  h.sim.setFaults({
    failSendRate: 0.1,
    rateLimitRate: 0.1,
    duplicateRate: 0.3,
    reorderWindowMs: 100,
  });

  const ids: string[] = [];
  for (const conversation of conversations) {
    await withTenant(h.deps.db, h.tenant.id, (tx) =>
      transitionConversation(tx, {
        conversationId: conversation.id,
        to: 'human',
        actor: { type: 'user', userId: h.tenant.agentId },
        reason: 'soak',
      }),
    );
    for (let i = 1; i <= REPLIES_PER_CUSTOMER; i++) {
      const id = await withTenant(h.deps.db, h.tenant.id, (tx) =>
        queueReply(tx, {
          conversationId: conversation.id,
          sender: { type: 'user', userId: h.tenant.agentId },
          content: { kind: 'text', body: `reply ${String(i)}` },
          now: new Date(),
        }),
      );
      await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
      ids.push(id);
    }
  }

  const outbound = and(
    eq(schema.messages.tenantId, h.tenant.id),
    eq(schema.messages.direction, 'outbound'),
  );
  await waitFor(
    'every reply delivered',
    async () => {
      const [row] = await h.migrator.db
        .select({ done: sql<number>`count(*) filter (where status in ('delivered', 'read'))::int` })
        .from(schema.messages)
        .where(outbound);
      return row?.done === ids.length;
    },
    90_000,
  );

  const total = CUSTOMERS * REPLIES_PER_CUSTOMER;
  expect(await count(outbound)).toEqual({ n: total, distinct: total });
  const expectedOrder = Array.from(
    { length: REPLIES_PER_CUSTOMER },
    (_, i) => `reply ${String(i + 1)}`,
  );
  for (const customer of h.customers) {
    const received = h.sim.state.thread(customer.id).filter((m) => m.direction === 'out');
    expect(received.map((m) => m.text)).toEqual(expectedOrder);
  }
  const [retried] = await h.migrator.db
    .select({ n: sql<number>`count(*) filter (where attempts > 1)::int` })
    .from(schema.messages)
    .where(outbound);
  expect(retried?.n).toBeGreaterThan(0); // faults actually fired
}, 150_000);
