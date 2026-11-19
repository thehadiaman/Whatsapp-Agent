import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema, type DbHandle } from '@app/db';
import { LocalDiskStorage, mediaKey } from '@app/pipeline';
import {
  conversationDetailSchema,
  conversationListItemSchema,
  type ConversationState,
} from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertUser } from '../seed/seed.js';
import {
  arrangeDb,
  call,
  createTestTenant,
  PASSWORD,
  signIn,
  startApi,
  testConfig,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

let api: RunningApi;
let db: DbHandle;
let storageDir: string;
let a: TestTenant & { channelId: string; agent2Email: string };
let b: TestTenant & { channelId: string };
const cookies: Record<string, string> = {};

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

async function withChannel<T extends TestTenant>(tenant: T): Promise<T & { channelId: string }> {
  const [channel] = await db.db
    .insert(schema.channels)
    .values({
      tenantId: tenant.id,
      provider: 'simulator',
      phoneNumberId: `1${digits(14)}`,
      displayPhoneNumber: '+971 4 000 0000',
      reopenTemplateName: 'reopen_conversation',
    })
    .returning();
  return { ...tenant, channelId: channel!.id };
}

let numberSeq = 1;
async function conversation(
  tenant: { id: string; channelId: string },
  options: { state?: ConversationState; holderEmail?: string; lastInboundHoursAgo?: number } = {},
): Promise<string> {
  const [customer] = await db.db
    .insert(schema.customers)
    .values({
      tenantId: tenant.id,
      bsuid: `AE.${digits(20)}`,
      waId: `9715${digits(8)}`,
      profileName: 'Fatima',
    })
    .returning();
  let holderUserId: string | null = null;
  if (options.holderEmail) {
    const [user] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, options.holderEmail));
    holderUserId = user!.id;
  }
  const lastInboundAt = new Date(Date.now() - (options.lastInboundHoursAgo ?? 0.1) * 3_600_000);
  const [conv] = await db.db
    .insert(schema.conversations)
    .values({
      tenantId: tenant.id,
      channelId: tenant.channelId,
      customerId: customer!.id,
      number: numberSeq++,
      state: options.state ?? 'assistant',
      holderUserId,
      lastInboundAt,
      lastMessageAt: lastInboundAt,
      nextOutboxSeq: 2,
    })
    .returning();
  await db.db.insert(schema.conversationTransitions).values([
    {
      tenantId: tenant.id,
      conversationId: conv!.id,
      fromState: null,
      toState: 'assistant',
      actorType: 'system',
      reason: 'Customer started a conversation',
      createdAt: lastInboundAt,
    },
    ...(options.state === 'waiting_for_human'
      ? [
          {
            tenantId: tenant.id,
            conversationId: conv!.id,
            fromState: 'assistant' as const,
            toState: 'waiting_for_human' as const,
            actorType: 'assistant' as const,
            reason: 'Customer asked for a person',
            createdAt: new Date(lastInboundAt.getTime() + 1_000),
          },
        ]
      : []),
  ]);
  await db.db.insert(schema.messages).values({
    tenantId: tenant.id,
    channelId: tenant.channelId,
    conversationId: conv!.id,
    direction: 'inbound',
    kind: 'text',
    senderType: 'customer',
    waMessageId: `wamid.T${digits(20)}`,
    body: 'هل وصل طلبي؟',
    status: 'received',
    waTimestamp: lastInboundAt,
  });
  return conv!.id;
}

beforeAll(async () => {
  db = arrangeDb();
  storageDir = await mkdtemp(join(tmpdir(), 'inbox-media-'));
  const base = await createTestTenant(db, 'ia');
  const agent2Email = `agent2-${randomUUID().slice(0, 8)}@test.example`;
  const agent2 = await upsertUser(db.db, {
    name: 'Second Agent',
    email: agent2Email,
    password: PASSWORD,
  });
  await db.db
    .insert(schema.memberships)
    .values({ tenantId: base.id, userId: agent2, role: 'agent' });
  a = { ...(await withChannel(base)), agent2Email };
  b = await withChannel(await createTestTenant(db, 'ib'));

  api = await startApi(testConfig({ MEDIA_STORAGE_DIR: storageDir }));
  [cookies['ownerA'], cookies['agentA'], cookies['agent2A'], cookies['ownerB']] = await Promise.all(
    [
      signIn(api, a.ownerEmail),
      signIn(api, a.agentEmail),
      signIn(api, a.agent2Email),
      signIn(api, b.ownerEmail),
    ],
  );
});

afterAll(async () => {
  await api.close();
  await db.close();
});

const post = (path: string, cookie: string, body: unknown = {}) =>
  call(api, path, { method: 'POST', cookie, body });

describe('reading the inbox', () => {
  it("lists only the caller's conversations, with waiting time and window", async () => {
    const waiting = await conversation(a, { state: 'waiting_for_human' });
    const other = await conversation(b);
    const { status, json } = await call(api, '/api/conversations', { cookie: cookies['agentA']! });
    expect(status).toBe(200);
    const items = (json as unknown[]).map((i) => conversationListItemSchema.parse(i));
    expect(items.some((i) => i.id === other)).toBe(false);
    const item = items.find((i) => i.id === waiting);
    expect(item?.state).toBe('waiting_for_human');
    expect(item?.waitingSince).not.toBeNull();
    expect(item?.lastMessage).toMatchObject({ direction: 'inbound', preview: 'هل وصل طلبي؟' });
    expect(new Date(item!.windowClosesAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a timeline of transitions, messages and notes in time order', async () => {
    const id = await conversation(a, { state: 'waiting_for_human' });
    expect(
      (
        await post(`/api/conversations/${id}/notes`, cookies['agentA']!, {
          text: 'Called the courier',
        })
      ).status,
    ).toBe(201);
    const detail = conversationDetailSchema.parse(
      (await call(api, `/api/conversations/${id}`, { cookie: cookies['agentA']! })).json,
    );
    // Started with the message, moved to waiting a second later, then the note.
    expect(detail.timeline.map((e) => e.type)).toEqual([
      'transition',
      'message',
      'transition',
      'note',
    ]);
    expect(detail.timeline.at(-1)).toMatchObject({
      type: 'note',
      body: 'Called the courier',
      authorName: 'Agent ia',
    });
  });

  it('another business gets 404 for this conversation and cannot add notes to it', async () => {
    const id = await conversation(a);
    expect(
      (await call(api, `/api/conversations/${id}`, { cookie: cookies['ownerB']! })).status,
    ).toBe(404);
    expect(
      (await post(`/api/conversations/${id}/notes`, cookies['ownerB']!, { text: 'x' })).status,
    ).toBe(404);
  });
});

describe('ownership', () => {
  it('first take-over wins; a second person gets 409 with a reason', async () => {
    const id = await conversation(a, { state: 'waiting_for_human' });
    expect((await post(`/api/conversations/${id}/take-over`, cookies['agentA']!)).status).toBe(200);
    const second = await post(`/api/conversations/${id}/take-over`, cookies['agent2A']!);
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.json)).toContain('Someone else already holds');
  });

  it('an agent cannot reassign a colleague’s conversation; an owner can', async () => {
    const id = await conversation(a, { state: 'human', holderEmail: a.agentEmail });
    const [agent2] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, a.agent2Email));
    expect(
      (await post(`/api/conversations/${id}/assign`, cookies['agent2A']!, { userId: agent2!.id }))
        .status,
    ).toBe(409);
    expect(
      (await post(`/api/conversations/${id}/assign`, cookies['ownerA']!, { userId: agent2!.id }))
        .status,
    ).toBe(200);
    const detail = conversationDetailSchema.parse(
      (await call(api, `/api/conversations/${id}`, { cookie: cookies['ownerA']! })).json,
    );
    expect(detail.holder?.name).toBe('Second Agent');
    expect(detail.timeline.at(-1)).toMatchObject({
      type: 'transition',
      from: 'human',
      to: 'human',
      reason: 'Assigned to Second Agent by Owner ia',
    });
  });

  it('cannot assign to someone from another business', async () => {
    const id = await conversation(a);
    const [ownerB] = await db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, b.ownerEmail));
    expect(
      (await post(`/api/conversations/${id}/assign`, cookies['ownerA']!, { userId: ownerB!.id }))
        .status,
    ).toBe(404);
  });

  it('closing moves the conversation out of the open list', async () => {
    const id = await conversation(a, { state: 'human', holderEmail: a.agentEmail });
    expect((await post(`/api/conversations/${id}/close`, cookies['agentA']!)).status).toBe(200);
    const open = (await call(api, '/api/conversations', { cookie: cookies['agentA']! })).json as {
      id: string;
    }[];
    const closed = (
      await call(api, '/api/conversations?scope=closed', { cookie: cookies['agentA']! })
    ).json as { id: string }[];
    expect(open.some((c) => c.id === id)).toBe(false);
    expect(closed.some((c) => c.id === id)).toBe(true);
  });
});

describe('replies', () => {
  it('outside the window, free text is refused and the reopen template is accepted', async () => {
    const id = await conversation(a, {
      state: 'human',
      holderEmail: a.agentEmail,
      lastInboundHoursAgo: 30,
    });
    const text = await post(`/api/conversations/${id}/replies`, cookies['agentA']!, {
      text: 'late',
    });
    expect(text.status).toBe(409);
    expect((text.json as { code: string }).code).toBe('window_closed');
    expect(
      (await post(`/api/conversations/${id}/replies`, cookies['agentA']!, { template: 'reopen' }))
        .status,
    ).toBe(202);
  });

  it('a failed reply can be sent again by the holder, and only a failed one', async () => {
    const id = await conversation(a, { state: 'human', holderEmail: a.agentEmail });
    const [failed] = await db.db
      .insert(schema.messages)
      .values({
        tenantId: a.id,
        channelId: a.channelId,
        conversationId: id,
        direction: 'outbound',
        kind: 'text',
        senderType: 'user',
        body: 'retry me',
        status: 'failed',
        outboxSeq: 1,
        attempts: 6,
        error: { code: 131000, message: 'Something went wrong' },
      })
      .returning();
    expect((await post(`/api/messages/${failed!.id}/retry`, cookies['agent2A']!)).status).toBe(409);
    expect((await post(`/api/messages/${failed!.id}/retry`, cookies['agentA']!)).status).toBe(202);
    const [row] = await db.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, failed!.id));
    expect(row).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect((await post(`/api/messages/${failed!.id}/retry`, cookies['agentA']!)).status).toBe(409);
  });
});

describe('rate limits', () => {
  it('limits notes to 30 a minute per person', async () => {
    const id = await conversation(a);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (
          await post(`/api/conversations/${id}/notes`, cookies['ownerA']!, {
            text: `note ${String(i)}`,
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Someone else on the team is unaffected.
    expect(
      (await post(`/api/conversations/${id}/notes`, cookies['agentA']!, { text: 'mine' })).status,
    ).toBe(201);
  });
});

describe('media', () => {
  async function mediaMessage(mimeType: string, stored: boolean) {
    const id = await conversation(a);
    const [m] = await db.db
      .insert(schema.messages)
      .values({
        tenantId: a.id,
        channelId: a.channelId,
        conversationId: id,
        direction: 'inbound',
        kind: mimeType.startsWith('image/') ? 'image' : 'document',
        senderType: 'customer',
        waMessageId: `wamid.M${digits(20)}`,
        status: 'received',
        media: { id: '1', mimeType, sha256: null, caption: null },
      })
      .returning();
    if (stored) {
      const key = mediaKey(a.id, m!.id);
      await new LocalDiskStorage(storageDir).put(
        key,
        new TextEncoder().encode('<html>x</html>'),
        mimeType,
      );
      await db.db
        .update(schema.messages)
        .set({ media: { id: '1', mimeType, sha256: null, caption: null, storageKey: key } })
        .where(eq(schema.messages.id, m!.id));
    }
    return m!.id;
  }

  it('serves images inline', async () => {
    const id = await mediaMessage('image/png', true);
    const response = await fetch(`${api.url}/api/media/${id}`, {
      headers: { cookie: cookies['agentA']! },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline');
  });

  it('forces a download for anything that could run in the page (HTML, SVG, PDF)', async () => {
    const id = await mediaMessage('text/html', true);
    const response = await fetch(`${api.url}/api/media/${id}`, {
      headers: { cookie: cookies['agentA']! },
    });
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment');
  });

  it('404s for media not stored yet, and for another business', async () => {
    const notYet = await mediaMessage('image/png', false);
    expect((await call(api, `/api/media/${notYet}`, { cookie: cookies['agentA']! })).status).toBe(
      404,
    );
    const stored = await mediaMessage('image/png', true);
    expect(
      (await fetch(`${api.url}/api/media/${stored}`, { headers: { cookie: cookies['ownerB']! } }))
        .status,
    ).toBe(404);
  });
});
