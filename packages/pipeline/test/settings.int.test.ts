import { MockChatModel, type ChatModel, type ModelRequest } from '@app/assistant';
import { schema, withTenant } from '@app/db';
import { localTime, WEEKDAYS, type OpeningHours } from '@app/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { transitionConversation } from '../src/conversations.js';
import { enqueueKnowledge } from '../src/queues.js';
import { startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h.close();
});

class RecordingModel implements ChatModel {
  readonly name = 'mock';
  readonly requests: ModelRequest[] = [];
  private readonly inner = new MockChatModel();
  complete(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    return this.inner.complete(request);
  }
}

async function start(settings: Partial<typeof schema.tenants.$inferInsert>, model?: ChatModel) {
  h = await startHarness({ sweepIntervalMs: 3_600_000, assistant: model ? { model } : {} });
  await h.migrator.db
    .update(schema.tenants)
    .set({
      name: 'Qamar Phone Corner',
      assistantSummary: 'A phone and accessories shop in Karama, Dubai.',
      ...settings,
    })
    .where(eq(schema.tenants.id, h.tenant.id));
  const [faq] = await h.migrator.db
    .insert(schema.knowledgeSources)
    .values({
      tenantId: h.tenant.id,
      kind: 'faq',
      title: 'Do you sell screen guards?',
      answer: 'Yes, tempered glass screen guards for most phones.',
    })
    .returning();
  await enqueueKnowledge(h.deps.queues, { tenantId: h.tenant.id, sourceId: faq!.id, version: 1 });
  await waitFor('faq read', async () => {
    const [row] = await h.migrator.db
      .select({ status: schema.knowledgeSources.status })
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, faq!.id));
    return row?.status === 'ready';
  });
}

const write = (text: string) => {
  h.sim.sendInbound([{ customerId: h.customers[0]!.id, type: 'text', text }]);
};

async function turns() {
  return h.migrator.db
    .select()
    .from(schema.assistantTurns)
    .where(eq(schema.assistantTurns.tenantId, h.tenant.id))
    .orderBy(asc(schema.assistantTurns.createdAt));
}

async function conversation() {
  const [row] = await h.migrator.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, h.tenant.id));
  return row!;
}

async function lastReply() {
  const rows = await h.migrator.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.tenantId, h.tenant.id))
    .orderBy(asc(schema.messages.createdAt));
  return rows.filter((m) => m.direction === 'outbound').at(-1);
}

describe('escalation rules', () => {
  it('a keyword hands the conversation to a person without asking the model', async () => {
    const model = new RecordingModel();
    await start({ escalationKeywords: ['refund', 'पैसे वापस'] }, model);
    write('mujhe पैसे वापस chahiye, phone kharab hai');
    await waitFor('a turn', async () => (await turns()).length === 1);
    expect((await turns())[0]).toMatchObject({
      outcome: 'handed_off',
      handoffReason: 'escalation_keyword',
      modelCalls: 0,
    });
    expect(model.requests).toHaveLength(0);
    const c = await conversation();
    expect(c).toMatchObject({ state: 'waiting_for_human' });
    // Scoped to this conversation: the migrator sees every test file's rows.
    const [transition] = await h.migrator.db
      .select()
      .from(schema.conversationTransitions)
      .where(
        and(
          eq(schema.conversationTransitions.conversationId, c.id),
          eq(schema.conversationTransitions.toState, 'waiting_for_human'),
        ),
      );
    expect(transition?.reason).toBe('Mentioned "पैसे वापस" (escalation rule)');
    // The customer is told, in their language and script, that a person will reply.
    expect((await lastReply())?.body).toMatch(/team se koi/);
  });

  it('after the set number of replies a person takes over; a hand-back starts the count again', async () => {
    await start({ maxAssistantReplies: 2 });
    for (let i = 1; i <= 2; i += 1) {
      write(`do you sell screen guards? (${String(i)})`);
      await waitFor(`turn ${String(i)}`, async () => (await turns()).length === i);
    }
    write('and screen guards for the S24?');
    await waitFor('third turn', async () => (await turns()).length === 3);
    expect((await turns())[2]).toMatchObject({
      outcome: 'handed_off',
      handoffReason: 'reply_limit',
      modelCalls: 0,
    });

    // A person hands it back: the assistant may reply twice more.
    const c = await conversation();
    await withTenant(h.deps.db, h.tenant.id, async (tx) => {
      await transitionConversation(tx, {
        conversationId: c.id,
        to: 'human',
        actor: { type: 'user', userId: h.tenant.ownerId },
        reason: 'Taken over',
      });
      await transitionConversation(tx, {
        conversationId: c.id,
        to: 'assistant',
        actor: { type: 'user', userId: h.tenant.ownerId },
        reason: 'Handed back',
      });
    });
    write('do you sell screen guards? (again)');
    await waitFor('fourth turn', async () => (await turns()).length === 4);
    expect((await turns())[3]).toMatchObject({ outcome: 'replied', handoffReason: null });
  });

  it('outside opening hours the handover says when a person will reply', async () => {
    // Closed all of today (in the shop's time zone), open 09:00–17:00 every other day.
    const today = localTime(new Date(), 'Asia/Dubai').weekday;
    const hours = Object.fromEntries(
      WEEKDAYS.map((d) => [d, d === today ? null : { open: '09:00', close: '17:00' }]),
    ) as OpeningHours;
    await start({ openingHours: hours, escalationKeywords: ['refund'] });
    write('I want a refund');
    await waitFor('a reply', async () => Boolean(await lastReply()));
    const body = (await lastReply())!.body!;
    expect(body).toContain('A person from our team will reply here soon.');
    expect(body).toMatch(
      /We're closed now\. A person from our team will reply when we open: \w+day 09:00\./,
    );
  });

  it('no line about opening hours when the owner turned it off', async () => {
    const hours = Object.fromEntries(WEEKDAYS.map((d) => [d, null])) as OpeningHours;
    await start({ openingHours: hours, outsideHoursNotice: false, escalationKeywords: ['refund'] });
    write('I want a refund');
    await waitFor('a reply', async () => Boolean(await lastReply()));
    expect((await lastReply())!.body).not.toContain('closed');
  });
});

describe('assistant settings', () => {
  it('passes the tone and the opening hours to the model', async () => {
    const model = new RecordingModel();
    const hours = Object.fromEntries(
      WEEKDAYS.map((d) => [d, d === 'sun' ? null : { open: '10:00', close: '22:00' }]),
    ) as OpeningHours;
    await start({ assistantTone: 'formal', openingHours: hours }, model);
    write('do you sell screen guards?');
    await waitFor('a turn', async () => (await turns()).length === 1);
    expect(model.requests[0]!.system).toContain('politely and formally');
    expect(model.requests[0]!.system).toContain('Mon–Sat 10:00–22:00 · Sun closed');
  });

  it("records the model's own handoff reason as a code", async () => {
    await start({});
    write('I want to talk to a person');
    await waitFor('a turn', async () => (await turns()).length === 1);
    expect((await turns())[0]).toMatchObject({
      outcome: 'handed_off',
      handoffReason: 'asked_for_person',
    });
  });
});
