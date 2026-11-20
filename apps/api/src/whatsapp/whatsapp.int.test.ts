import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { MockChatModel, MockEmbedder } from '@app/assistant';
import { createDb, schema, type DbHandle } from '@app/db';
import { testDatabaseUrls } from '@app/db/testing';
import {
  createQueues,
  LocalDiskStorage,
  noEvents,
  ProviderRegistry,
  startWorkers,
  type Queues,
  type RunningWorkers,
} from '@app/pipeline';
import { conversationDetailSchema, createLogger } from '@app/shared';
import { createSimulator, type Simulator } from '@app/simulator';
import { signPayload } from '@app/whatsapp';
import { and, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertTenant } from '../seed/seed.js';
import {
  arrangeDb,
  call,
  createTestTenant,
  PASSWORD,
  signIn,
  startApi,
  testConfig,
  type RunningApi,
} from '../test/harness.js';

// The whole pipeline through the real API: simulator → signed webhook →
// API (verify, store, enqueue) → worker → database → staff reply through the
// API → worker → simulator. Plus the webhook's own checks and cross-tenant access.

const SECRET = 'api-test-app-secret';
const TOKEN = 'api-test-access-token';
const VERIFY = 'api-test-verify-token';
const prefix = `api${randomUUID().slice(0, 8)}`;

let api: RunningApi;
let sim: Simulator;
let simClose: () => Promise<void>;
let workers: RunningWorkers;
let queues: Queues;
let connection: Redis;
let workerDb: DbHandle;
let migrator: DbHandle;
let phoneNumberId: string;
let tenantId: string;
let agent: string;
let otherOwner: string;
const customerBsuid = `AE.${String(randomInt(1e9))}${String(randomInt(1e9))}`;

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

beforeAll(async () => {
  migrator = arrangeDb();
  phoneNumberId = `1${digits(14)}`;
  const suffix = randomUUID().slice(0, 8);
  tenantId = await upsertTenant(migrator.db, {
    slug: `wa-${suffix}`,
    name: 'WhatsApp Tenant',
    timezone: 'Asia/Dubai',
    channel: { phoneNumberId, displayPhoneNumber: '+971 4 111 2222' },
    members: [
      {
        name: 'Agent',
        email: `agent-wa-${suffix}@test.example`,
        role: 'agent',
        password: PASSWORD,
      },
    ],
  });
  const other = await createTestTenant(migrator, 'other');

  const overrides = {
    SIMULATOR_GRAPH_URL: 'http://127.0.0.1:9', // the API itself never calls the Graph API
    SIMULATOR_ACCESS_TOKEN: TOKEN,
    SIMULATOR_APP_SECRET: SECRET,
    SIMULATOR_VERIFY_TOKEN: VERIFY,
    QUEUE_PREFIX: prefix,
  };
  api = await startApi(testConfig(overrides));
  [agent, otherOwner] = await Promise.all([
    signIn(api, `agent-wa-${suffix}@test.example`),
    signIn(api, other.ownerEmail),
  ]);

  sim = createSimulator({
    webhookUrl: `${api.url}/api/webhooks/whatsapp/simulator`,
    appSecret: SECRET,
    accessToken: TOKEN,
    seedDemo: false,
    statusStepMs: 20,
  });
  sim.state.businesses.set(phoneNumberId, {
    phoneNumberId,
    displayPhoneNumber: '+971 4 111 2222',
    name: 'WhatsApp Tenant',
  });
  sim.state.addCustomer({
    name: 'Fatima',
    bsuid: customerBsuid,
    waId: `9715${digits(8)}`,
    businessPhoneNumberId: phoneNumberId,
  });
  const simServer = await sim.listen(0);
  simClose = simServer.close;

  const redisUrl = process.env['TEST_REDIS_URL'] ?? '';
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const settings = { orderHoldMs: 200, outboundAttempts: 5, outboundBackoffMs: 20 };
  queues = createQueues(connection, settings, prefix);
  workerDb = createDb(testDatabaseUrls().user, { max: 5 });
  workers = startWorkers(
    {
      db: workerDb.db,
      queues,
      providers: new ProviderRegistry({
        simulator: {
          baseUrl: simServer.url,
          graphVersion: 'v26.0',
          accessToken: TOKEN,
          appSecret: SECRET,
          verifyToken: VERIFY,
        },
      }),
      storage: new LocalDiskStorage(await mkdtemp(join(tmpdir(), 'api-media-'))),
      logger: createLogger({
        service: 'worker-test',
        level: 'error',
        destination: new Writable({
          write: (_c, _e, done) => {
            done();
          },
        }),
      }),
      settings,
      events: noEvents,
      // Webhook handling only: the assistant's own tests live in @app/pipeline.
      assistant: {
        model: new MockChatModel(),
        embedder: new MockEmbedder(),
        settings: { enabled: false, debounceMs: 0, maxOutputTokens: 1024 },
      },
    },
    { connection, prefix },
  );
});

afterAll(async () => {
  await workers.close();
  await queues.close();
  await simClose();
  await api.close();
  connection.disconnect();
  await Promise.all([workerDb.close(), migrator.close()]);
});

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function conversationId(): Promise<string> {
  const [row] = await migrator.db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
    .where(eq(schema.customers.bsuid, customerBsuid));
  if (!row) throw new Error('no conversation');
  return row.id;
}

async function eventsMentioning(marker: string): Promise<number> {
  const [row] = await migrator.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.webhookEvents)
    .where(like(schema.webhookEvents.body, `%${marker}%`));
  return row?.n ?? 0;
}

describe('webhook endpoint', () => {
  it('answers the verification handshake only with the right token', async () => {
    const base = `${api.url}/api/webhooks/whatsapp/simulator?hub.mode=subscribe&hub.challenge=8675309`;
    const ok = await fetch(`${base}&hub.verify_token=${VERIFY}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('8675309');
    expect((await fetch(`${base}&hub.verify_token=wrong`)).status).toBe(403);
  });

  it('is not served for a provider that is not configured (Meta in mock mode)', async () => {
    const response = await fetch(`${api.url}/api/webhooks/whatsapp/meta`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('rejects a bad signature and stores nothing', async () => {
    const marker = `forged-${randomUUID()}`;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [], marker });
    const response = await fetch(`${api.url}/api/webhooks/whatsapp/simulator`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signPayload(body, 'not-the-secret'),
      },
      body,
    });
    expect(response.status).toBe(401);
    expect(await eventsMentioning(marker)).toBe(0);
  });

  it('accepts a correctly signed body and stores it raw', async () => {
    const marker = `signed-${randomUUID()}`;
    // Key order and spacing preserved: verification is over the exact bytes.
    const body = `{ "object": "whatsapp_business_account", "entry": [], "marker": "${marker}" }`;
    const response = await fetch(`${api.url}/api/webhooks/whatsapp/simulator`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signPayload(body, SECRET),
      },
      body,
    });
    expect(response.status).toBe(200);
    const [event] = await migrator.db
      .select()
      .from(schema.webhookEvents)
      .where(like(schema.webhookEvents.body, `%${marker}%`));
    expect(event?.body).toBe(body);
  });
});

describe('the whole pipeline through the API', () => {
  it('a customer message reaches the inbox; the agent takes over and replies; the customer receives it', async () => {
    sim.sendInbound([{ customerId: customerBsuid, type: 'text', text: 'هل وصل طلبي؟ KB-2291' }]);
    await waitFor('conversation created', async () => {
      const [row] = await migrator.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.direction, 'inbound')),
        );
      return (row?.n ?? 0) > 0;
    });
    const id = await conversationId();

    const before = await call(api, `/api/conversations/${id}`, { cookie: agent });
    expect(before.status).toBe(200);
    const detail = conversationDetailSchema.parse(before.json);
    expect(detail.timeline.filter((e) => e.type === 'message')).toEqual([
      expect.objectContaining({ direction: 'inbound', body: 'هل وصل طلبي؟ KB-2291' }),
    ]);

    // Replying before taking over is refused: the assistant holds it.
    const early = await call(api, `/api/conversations/${id}/replies`, {
      method: 'POST',
      cookie: agent,
      body: { text: 'Checking now' },
    });
    expect(early.status).toBe(409);

    expect(
      (await call(api, `/api/conversations/${id}/take-over`, { method: 'POST', cookie: agent }))
        .status,
    ).toBe(200);
    const sent = await call(api, `/api/conversations/${id}/replies`, {
      method: 'POST',
      cookie: agent,
      body: { text: 'Checking with the courier now' },
    });
    expect(sent.status).toBe(202);

    await waitFor('customer received the reply', () =>
      Promise.resolve(
        sim.state
          .thread(customerBsuid)
          .some((m) => m.direction === 'out' && m.status === 'delivered'),
      ),
    );
    expect(
      sim.state
        .thread(customerBsuid)
        .filter((m) => m.direction === 'out')
        .map((m) => m.text),
    ).toEqual(['Checking with the courier now']);

    const transitions = await migrator.db
      .select()
      .from(schema.conversationTransitions)
      .where(eq(schema.conversationTransitions.conversationId, id));
    expect(transitions.map((t) => [t.fromState, t.toState, t.actorType])).toEqual([
      [null, 'assistant', 'system'],
      ['assistant', 'human', 'user'],
    ]);
    const audit = await migrator.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetId, id),
          eq(schema.auditLog.action, 'conversation.taken_over'),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it('another tenant cannot read, take over or reply to this conversation', async () => {
    const id = await conversationId();
    expect((await call(api, `/api/conversations/${id}`, { cookie: otherOwner })).status).toBe(404);
    expect(
      (
        await call(api, `/api/conversations/${id}/hand-back`, {
          method: 'POST',
          cookie: otherOwner,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(api, `/api/conversations/${id}/replies`, {
          method: 'POST',
          cookie: otherOwner,
          body: { text: 'cross-tenant' },
        })
      ).status,
    ).toBe(404);
    expect(sim.state.thread(customerBsuid).some((m) => m.text === 'cross-tenant')).toBe(false);
  });
});
