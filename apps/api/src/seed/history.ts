import { randomUUID } from 'node:crypto';
import { schema, type Database } from '@app/db';
import { DEMO_BUSINESSES, nextOpening, type OpeningHours } from '@app/shared';
import { and, eq, like, sql } from 'drizzle-orm';

/**
 * Thirty days of closed conversations for the demo businesses, so the
 * analytics page has a history to show. Fictional and generated from a fixed
 * seed. Every turn is recorded as the mock model's, so its cost is $0, which
 * is true: no real model answered them. Only closed conversations, so the
 * inbox's open list is unchanged.
 */

const DAYS = 30;

/** Small deterministic generator (mulberry32), seeded per business. */
function generator(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Exchange {
  ask: string;
  answer: string;
}

const QUESTIONS: Record<string, Exchange[]> = {
  'qamar-phone-corner': [
    { ask: 'Is the Galaxy S24 in stock?', answer: 'Yes, the Galaxy S24 128 GB is in stock.' },
    {
      ask: 'bhai screen guard ka warranty kitna hai?',
      answer: 'Screen guard par warranty nahi hoti.',
    },
    { ask: 'هل لديكم شاحن آيفون؟', answer: 'نعم، لدينا شواحن أصلية لآيفون.' },
    { ask: 'Do you repair screens?', answer: 'Yes, for Samsung, Apple and Google phones.' },
    { ask: 'क्या आपके पास iPhone 15 का कवर है?', answer: 'हाँ, iPhone 15 के कवर उपलब्ध हैं।' },
  ],
  'kayal-bakes': [
    { ask: 'Do you have eggless chocolate cake?', answer: 'Yes, every cake can be made eggless.' },
    { ask: 'ഞായറാഴ്ച കേക്ക് കിട്ടുമോ?', answer: 'ഞായറാഴ്ച കട അടച്ചിരിക്കും.' },
    { ask: 'How early should I order a birthday cake?', answer: 'Order at least two days ahead.' },
    { ask: 'Do you deliver to Kaloor?', answer: 'Yes, we deliver across Kochi.' },
  ],
};

const HANDOFFS: { code: string; reason: string; weight: number }[] = [
  { code: 'asked_for_person', reason: 'Customer asked for a person', weight: 5 },
  { code: 'not_in_knowledge', reason: 'Not in the knowledge base', weight: 3 },
  { code: 'complaint', reason: 'Customer is unhappy', weight: 1 },
  { code: 'escalation_keyword', reason: 'Mentioned "refund" (escalation rule)', weight: 1 },
];

const NAMES = [
  'Arjun Menon',
  'Fathima Rasheed',
  'Vikram Rao',
  'Noura Al Hammadi',
  'Rohit Verma',
  'Anjali Pillai',
  'Khalid Saeed',
  'Meera Nair',
  'Imran Qureshi',
  'Divya Thomas',
  'Salim Abdulla',
  'Pooja Iyer',
  'Hassan Ali',
  'Reshma George',
  'Sameer Khan',
];

/** Seeds history for each demo business that has none yet. */
export async function seedHistory(db: Database, options: { now?: number } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  for (const business of DEMO_BUSINESSES) {
    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, business.slug));
    if (!tenant) continue;
    // Seeded once: its customers are recognisable (HIST.*), whatever else the database holds.
    const [existing] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, tenant.id), like(schema.customers.bsuid, 'HIST.%')));
    if ((existing?.n ?? 0) > 0) continue;
    const [channel] = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.tenantId, tenant.id));
    const staff = await db
      .select({ id: schema.memberships.userId })
      .from(schema.memberships)
      .where(eq(schema.memberships.tenantId, tenant.id));
    if (!channel || staff.length === 0) continue;
    await seedTenantHistory(db, {
      tenant,
      channelId: channel.id,
      staffIds: staff.map((s) => s.id),
      exchanges: QUESTIONS[business.slug] ?? [],
      now,
    });
  }
}

async function seedTenantHistory(
  db: Database,
  input: {
    tenant: typeof schema.tenants.$inferSelect;
    channelId: string;
    staffIds: string[];
    exchanges: Exchange[];
    now: number;
  },
): Promise<void> {
  const { tenant, channelId, staffIds, exchanges, now } = input;
  const random = generator(tenant.slug);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const hours: OpeningHours | null = tenant.openingHours;

  const customers = await db
    .insert(schema.customers)
    .values(
      NAMES.map((name, i) => ({
        tenantId: tenant.id,
        bsuid: `HIST.${tenant.slug.slice(0, 5).toUpperCase()}.${String(i).padStart(4, '0')}`,
        profileName: name,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.customers.id });
  if (customers.length === 0) return;

  const conversations: (typeof schema.conversations.$inferInsert)[] = [];
  const messages: (typeof schema.messages.$inferInsert)[] = [];
  const transitions: (typeof schema.conversationTransitions.$inferInsert)[] = [];
  const turns: (typeof schema.assistantTurns.$inferInsert)[] = [];
  const [counter] = await db
    .select({ next: schema.tenants.nextConversationNumber })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenant.id));
  let number = counter?.next ?? 1;

  for (let day = DAYS; day >= 3; day -= 1) {
    const perDay = 12 + Math.floor(random() * 14);
    for (let i = 0; i < perDay; i += 1) {
      // Mostly daytime, some late evening (after hours for a bakery).
      const at = new Date(now - day * 86_400_000 + (random() * 14 + 5) * 3_600_000);
      const conversationId = randomUUID();
      const customerId = pick(customers).id;
      const exchange = pick(exchanges);
      const replyMs = 1_600 + Math.floor(random() * 2_800);
      const askId = randomUUID();
      const answerId = randomUUID();
      let t = at.getTime();
      const step = (ms: number) => new Date((t += ms));

      messages.push({
        id: askId,
        tenantId: tenant.id,
        channelId,
        conversationId,
        direction: 'inbound',
        kind: 'text',
        senderType: 'customer',
        waMessageId: `wamid.HIST${askId}`,
        body: exchange.ask,
        status: 'received',
        statusAt: at,
        waTimestamp: at,
        createdAt: at,
      });
      transitions.push({
        tenantId: tenant.id,
        conversationId,
        fromState: null,
        toState: 'assistant',
        actorType: 'system',
        reason: 'Customer started a conversation',
        createdAt: at,
      });

      const roll = random();
      const handoff = roll < 0.22 ? pickWeighted(HANDOFFS, random) : null;
      const takenOver = !handoff && roll < 0.27;
      const answeredAt = step(replyMs);
      messages.push({
        id: answerId,
        tenantId: tenant.id,
        channelId,
        conversationId,
        direction: 'outbound',
        kind: 'text',
        senderType: 'assistant',
        waMessageId: `wamid.HIST${answerId}`,
        body: handoff ? 'A person from our team will reply here soon.' : exchange.answer,
        status: 'read',
        statusAt: answeredAt,
        outboxSeq: 1,
        attempts: 1,
        sentAt: answeredAt,
        createdAt: answeredAt,
      });
      turns.push({
        tenantId: tenant.id,
        conversationId,
        customerId,
        triggerMessageId: askId,
        replyMessageId: answerId,
        model: 'mock',
        outcome: handoff ? 'handed_off' : 'replied',
        basis: handoff ? null : 'knowledge',
        language: null,
        inputTokens: 1_900 + Math.floor(random() * 900),
        outputTokens: 60 + Math.floor(random() * 90),
        costMicros: 0,
        latencyMs: replyMs - 1_500,
        modelCalls: 1,
        passages: [],
        toolCalls: [],
        handoffReason: handoff?.code ?? null,
        createdAt: answeredAt,
      });

      let seq = 2;
      const staffId = pick(staffIds);
      if (handoff || takenOver) {
        if (handoff) {
          const waitingAt = step(1_000);
          transitions.push({
            tenantId: tenant.id,
            conversationId,
            fromState: 'assistant',
            toState: 'waiting_for_human',
            actorType: 'assistant',
            reason: handoff.reason,
            createdAt: waitingAt,
          });
          // A person picks it up a few minutes later, or when the shop opens.
          const opens = nextOpening(hours, tenant.timezone, waitingAt);
          t = (opens ? opens.getTime() : t) + (2 + random() * 14) * 60_000;
        } else {
          step((1 + random() * 5) * 60_000);
        }
        const tookAt = new Date(t);
        transitions.push({
          tenantId: tenant.id,
          conversationId,
          fromState: handoff ? 'waiting_for_human' : 'assistant',
          toState: 'human',
          actorType: 'user',
          actorUserId: staffId,
          reason: 'Taken over',
          createdAt: tookAt,
        });
        const staffReplyId = randomUUID();
        const repliedAt = step(30_000 + random() * 90_000);
        messages.push({
          id: staffReplyId,
          tenantId: tenant.id,
          channelId,
          conversationId,
          direction: 'outbound',
          kind: 'text',
          senderType: 'user',
          senderUserId: staffId,
          waMessageId: `wamid.HIST${staffReplyId}`,
          body: 'Thanks for waiting. I can help with that.',
          status: 'read',
          statusAt: repliedAt,
          outboxSeq: seq++,
          attempts: 1,
          sentAt: repliedAt,
          createdAt: repliedAt,
        });
      }
      const closedAt = step((20 + random() * 120) * 60_000);
      transitions.push({
        tenantId: tenant.id,
        conversationId,
        fromState: handoff || takenOver ? 'human' : 'assistant',
        toState: 'closed',
        actorType: handoff || takenOver ? 'user' : 'system',
        actorUserId: handoff || takenOver ? staffId : null,
        reason: 'Closed',
        createdAt: closedAt,
      });
      conversations.push({
        id: conversationId,
        tenantId: tenant.id,
        channelId,
        customerId,
        number: number++,
        state: 'closed',
        lastInboundAt: at,
        lastMessageAt: new Date(t),
        nextOutboxSeq: seq,
        createdAt: at,
        updatedAt: closedAt,
      });
    }
  }

  // Parents before children; in slices to stay under Postgres's parameter limit.
  const insert = async <T>(rows: T[], write: (slice: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 500) await write(rows.slice(i, i + 500));
  };
  await insert(conversations, (s) => db.insert(schema.conversations).values(s));
  await insert(messages, (s) => db.insert(schema.messages).values(s));
  await insert(transitions, (s) => db.insert(schema.conversationTransitions).values(s));
  await insert(turns, (s) => db.insert(schema.assistantTurns).values(s));
  await db
    .update(schema.tenants)
    .set({ nextConversationNumber: number })
    .where(eq(schema.tenants.id, tenant.id));
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], random: () => number): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1] as T;
}
