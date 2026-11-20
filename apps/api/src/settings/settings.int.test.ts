import { randomInt } from 'node:crypto';
import { schema, type DbHandle } from '@app/db';
import {
  analyticsSchema,
  linkInfoSchema,
  staffLinkSchema,
  staffSchema,
  tenantSettingsSchema,
  type TenantSettings,
} from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrangeDb,
  call,
  createTestTenant,
  signIn,
  startApi,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

let api: RunningApi;
let db: DbHandle;
let a: TestTenant;
let b: TestTenant;
const cookies: Record<string, string> = {};

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');
const put = (path: string, cookie: string, body: unknown) =>
  call(api, path, { method: 'PUT', cookie, body });
const post = (path: string, cookie: string | undefined, body: unknown = {}) =>
  call(api, path, { method: 'POST', ...(cookie ? { cookie } : {}), body });

const week = {
  mon: { open: '10:00', close: '22:00' },
  tue: { open: '10:00', close: '22:00' },
  wed: { open: '10:00', close: '22:00' },
  thu: { open: '10:00', close: '22:00' },
  fri: { open: '14:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};

beforeAll(async () => {
  db = arrangeDb();
  a = await createTestTenant(db, 'sa');
  b = await createTestTenant(db, 'sb');
  api = await startApi();
  [cookies['ownerA'], cookies['agentA'], cookies['ownerB']] = await Promise.all([
    signIn(api, a.ownerEmail),
    signIn(api, a.agentEmail),
    signIn(api, b.ownerEmail),
  ]);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

describe('settings', () => {
  it('an owner saves each section; each save is audited and stamped', async () => {
    const saved = await put('/api/settings/hours', cookies['ownerA']!, { hours: week });
    expect(saved.status).toBe(200);
    const settings = tenantSettingsSchema.parse(saved.json);
    expect(settings.hours).toEqual(week);
    expect(settings.lastChanged.hours).toMatchObject({ by: 'Owner sa' });
    expect(settings.lastChanged.voice).toBeNull();

    expect(
      (
        await put('/api/settings/escalation', cookies['ownerA']!, {
          keywords: ['refund', 'Refund', 'शिकायत'],
          maxAssistantReplies: 6,
          outsideHoursNotice: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put('/api/settings/voice', cookies['ownerA']!, {
          languages: ['en', 'hi'],
          voiceReplies: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put('/api/settings/templates', cookies['ownerA']!, {
          reopen: { en: 'reopen_conversation', hi: 'reopen_conversation_hi' },
        })
      ).status,
    ).toBe(200);

    const [tenant] = await db.db.select().from(schema.tenants).where(eq(schema.tenants.id, a.id));
    expect(tenant).toMatchObject({
      openingHours: week,
      escalationKeywords: ['refund', 'शिकायत'],
      maxAssistantReplies: 6,
      languages: ['en', 'hi'],
      voiceReplies: true,
      reopenTemplates: { en: 'reopen_conversation', hi: 'reopen_conversation_hi' },
    });
    const audit = await db.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.tenantId, a.id),
          eq(schema.auditLog.action, 'settings.voice.updated'),
        ),
      );
    expect(audit[0]).toMatchObject({
      before: { languages: ['en'], voiceReplies: false },
      after: { languages: ['en', 'hi'], voiceReplies: true },
    });
  });

  it('an agent can read settings but not change them', async () => {
    const read = await call(api, '/api/settings', { cookie: cookies['agentA']! });
    expect(read.status).toBe(200);
    expect((read.json as TenantSettings).business.name).toBe('Tenant SA');
    expect(
      (
        await put('/api/settings/voice', cookies['agentA']!, {
          languages: ['en'],
          voiceReplies: false,
        })
      ).status,
    ).toBe(403);
  });

  it('refuses invalid settings with a reason', async () => {
    const backwards = await put('/api/settings/hours', cookies['ownerA']!, {
      hours: { ...week, mon: { open: '22:00', close: '10:00' } },
    });
    expect(backwards.status).toBe(400);
    expect(JSON.stringify(backwards.json)).toContain('closing time must be after opening time');
    expect(
      (
        await put('/api/settings/voice', cookies['ownerA']!, {
          languages: ['fr'],
          voiceReplies: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put('/api/settings/templates', cookies['ownerA']!, {
          reopen: { en: 'Reopen Conversation!' },
        })
      ).status,
    ).toBe(400);
  });

  it("one business's settings never show or change another's", async () => {
    await put('/api/settings/business', cookies['ownerB']!, {
      name: 'Tenant SB renamed',
      summary: 'A test business for isolation checks.',
      timezone: 'Asia/Kolkata',
    });
    const mine = tenantSettingsSchema.parse(
      (await call(api, '/api/settings', { cookie: cookies['ownerA']! })).json,
    );
    expect(mine.business.name).toBe('Tenant SA');
    expect(mine.business.timezone).not.toBe('Asia/Kolkata');
  });
});

describe('staff', () => {
  it('an invite link creates an account in this business, once', async () => {
    const email = `new-${digits(6)}@test.example`;
    const made = await post('/api/staff/invites', cookies['ownerA'], {
      name: 'Nadia',
      email,
      role: 'agent',
    });
    expect(made.status).toBe(201);
    const link = staffLinkSchema.parse(made.json);
    expect(link.url).toMatch(/^http:\/\/localhost:3000\/join\/[A-Za-z0-9_-]{43}$/);
    const token = link.url.split('/').at(-1)!;

    // Only the hash is stored.
    const [stored] = await db.db
      .select()
      .from(schema.staffInvites)
      .where(eq(schema.staffInvites.email, email));
    expect(stored!.tokenHash).not.toContain(token);

    const info = linkInfoSchema.parse((await call(api, `/api/links/invite/${token}`)).json);
    expect(info).toEqual({ kind: 'invite', business: 'Tenant SA', name: 'Nadia', email });

    const accepted = await post(`/api/links/invite/${token}`, undefined, {
      name: 'Nadia Rahman',
      password: 'a-long-new-password',
    });
    expect(accepted.status).toBe(201);
    const cookie = await signIn(api, email, 'a-long-new-password');
    const me = await call(api, '/api/me', { cookie });
    expect(me.json).toMatchObject({ membership: { tenantId: a.id, role: 'agent' } });

    // Used once; a second try and a made-up token look the same.
    expect(
      (
        await post(`/api/links/invite/${token}`, undefined, {
          name: 'X Y',
          password: 'another-long-password',
        })
      ).status,
    ).toBe(410);
    expect((await call(api, `/api/links/invite/${'x'.repeat(43)}`)).status).toBe(410);
    const staff = staffSchema.parse(
      (await call(api, '/api/staff', { cookie: cookies['ownerA']! })).json,
    );
    expect(staff.members.some((m) => m.email === email)).toBe(true);
    expect(staff.invites.some((i) => i.email === email)).toBe(false);
  });

  it('refuses an invite for someone who already has an account, and agents cannot invite', async () => {
    expect(
      (
        await post('/api/staff/invites', cookies['ownerA'], {
          name: 'Dup',
          email: b.ownerEmail,
          role: 'agent',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post('/api/staff/invites', cookies['agentA'], {
          name: 'Sneaky',
          email: 'x@test.example',
          role: 'owner',
        })
      ).status,
    ).toBe(403);
  });

  it('a reset link sets a new password and signs the person out everywhere', async () => {
    const [agent] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, a.agentEmail));
    const before = await signIn(api, a.agentEmail);
    const link = staffLinkSchema.parse(
      (await post(`/api/staff/${agent!.id}/reset-link`, cookies['ownerA'])).json,
    );
    const token = link.url.split('/').at(-1)!;
    expect(linkInfoSchema.parse((await call(api, `/api/links/reset/${token}`)).json)).toMatchObject(
      {
        kind: 'reset',
        email: a.agentEmail,
      },
    );
    expect((await post(`/api/links/reset/${token}`, undefined, { password: 'short' })).status).toBe(
      400,
    );
    expect(
      (await post(`/api/links/reset/${token}`, undefined, { password: 'brand-new-password-1' }))
        .status,
    ).toBe(200);
    expect((await call(api, '/api/me', { cookie: before })).status).toBe(401);
    await expect(signIn(api, a.agentEmail)).rejects.toThrow(/sign-in failed/);
    cookies['agentA'] = await signIn(api, a.agentEmail, 'brand-new-password-1');
    expect(
      (await post(`/api/links/reset/${token}`, undefined, { password: 'brand-new-password-2' }))
        .status,
    ).toBe(410);
  });

  it("another business's owner cannot touch this business's staff", async () => {
    const [agent] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, a.agentEmail));
    expect((await post(`/api/staff/${agent!.id}/reset-link`, cookies['ownerB'])).status).toBe(404);
    expect(
      (await call(api, `/api/staff/${agent!.id}`, { method: 'DELETE', cookie: cookies['ownerB']! }))
        .status,
    ).toBe(404);
  });

  it('removing someone ends their access, and their conversations wait for another person', async () => {
    const [agent] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, a.agentEmail));
    const [channel] = await db.db
      .insert(schema.channels)
      .values({
        tenantId: a.id,
        provider: 'simulator',
        phoneNumberId: `1${digits(14)}`,
        displayPhoneNumber: '+971 4 000 0001',
      })
      .returning();
    const [customer] = await db.db
      .insert(schema.customers)
      .values({ tenantId: a.id, bsuid: `AE.${digits(20)}` })
      .returning();
    const [held] = await db.db
      .insert(schema.conversations)
      .values({
        tenantId: a.id,
        channelId: channel!.id,
        customerId: customer!.id,
        number: 9_000 + randomInt(999),
        state: 'human',
        holderUserId: agent!.id,
      })
      .returning();

    expect(
      (await call(api, `/api/staff/${agent!.id}`, { method: 'DELETE', cookie: cookies['ownerA']! }))
        .status,
    ).toBe(204);
    expect((await call(api, '/api/me', { cookie: cookies['agentA']! })).status).toBe(401);
    const [after] = await db.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, held!.id));
    expect(after).toMatchObject({ state: 'waiting_for_human', holderUserId: null });
    const [membership] = await db.db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, agent!.id));
    expect(membership).toBeUndefined();
  });

  it('an owner cannot remove themselves', async () => {
    const [owner] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, a.ownerEmail));
    expect(
      (await call(api, `/api/staff/${owner!.id}`, { method: 'DELETE', cookie: cookies['ownerA']! }))
        .status,
    ).toBe(409);
  });
});

describe('analytics', () => {
  it('counts conversations by who held them, and reasons for handing over', async () => {
    const [channel] = await db.db
      .insert(schema.channels)
      .values({
        tenantId: b.id,
        provider: 'simulator',
        phoneNumberId: `1${digits(14)}`,
        displayPhoneNumber: '+91 484 000 0002',
      })
      .returning();
    const make = async (
      state: 'assistant' | 'waiting_for_human' | 'closed',
      handedOver: boolean,
    ) => {
      const [customer] = await db.db
        .insert(schema.customers)
        .values({ tenantId: b.id, bsuid: `IN.${digits(20)}` })
        .returning();
      const [c] = await db.db
        .insert(schema.conversations)
        .values({
          tenantId: b.id,
          channelId: channel!.id,
          customerId: customer!.id,
          number: randomInt(1, 1_000_000),
          state,
        })
        .returning();
      const asked = new Date(Date.now() - 60_000);
      const [ask] = await db.db
        .insert(schema.messages)
        .values({
          tenantId: b.id,
          channelId: channel!.id,
          conversationId: c!.id,
          direction: 'inbound',
          kind: 'text',
          senderType: 'customer',
          body: 'hello',
          status: 'received',
          waTimestamp: asked,
        })
        .returning();
      const [reply] = await db.db
        .insert(schema.messages)
        .values({
          tenantId: b.id,
          channelId: channel!.id,
          conversationId: c!.id,
          direction: 'outbound',
          kind: 'text',
          senderType: 'assistant',
          body: 'hi',
          status: 'delivered',
          outboxSeq: 1,
          sentAt: new Date(asked.getTime() + 2_000),
        })
        .returning();
      await db.db.insert(schema.assistantTurns).values({
        tenantId: b.id,
        conversationId: c!.id,
        customerId: customer!.id,
        triggerMessageId: ask!.id,
        replyMessageId: reply!.id,
        model: 'anthropic.claude-haiku-5-5',
        outcome: handedOver ? 'handed_off' : 'replied',
        costMicros: 300,
        handoffReason: handedOver ? 'asked_for_person' : null,
      });
      if (handedOver) {
        await db.db.insert(schema.conversationTransitions).values({
          tenantId: b.id,
          conversationId: c!.id,
          fromState: 'assistant',
          toState: 'waiting_for_human',
          actorType: 'assistant',
          reason: 'Customer asked for a person',
        });
      }
    };
    await make('assistant', false);
    await make('closed', false);
    await make('waiting_for_human', true);

    const result = await call(api, '/api/analytics?days=7', { cookie: cookies['ownerB']! });
    expect(result.status).toBe(200);
    const data = analyticsSchema.parse(result.json);
    expect(data.byDay).toHaveLength(7);
    expect(data.summary).toMatchObject({
      conversations: 3,
      assistantOnly: 2,
      costPerConversationMicros: 300,
      replyMedianMs: 2_000,
    });
    const today = data.byDay.at(-1)!;
    expect(today).toMatchObject({
      conversations: 3,
      assistantOnly: 2,
      waiting: 1,
      personTookPart: 0,
      handoffs: 1,
    });
    expect(data.reasons).toEqual([{ code: 'asked_for_person', count: 1 }]);

    // Another business sees none of it.
    const c = await createTestTenant(db, 'sc');
    const other = analyticsSchema.parse(
      (await call(api, '/api/analytics?days=7', { cookie: await signIn(api, c.ownerEmail) })).json,
    );
    expect(other.summary.conversations).toBe(0);
    expect(other.reasons).toEqual([]);
    expect((await call(api, '/api/analytics?days=9', { cookie: cookies['ownerB']! })).status).toBe(
      400,
    );
  });
});
