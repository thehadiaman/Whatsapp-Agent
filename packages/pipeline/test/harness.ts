import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createDb, schema, type DbHandle } from '@app/db';
import { testDatabaseUrls } from '@app/db/testing';
import { createLogger } from '@app/shared';
import { createSimulator, seededRandom, type FaultSettings, type Simulator } from '@app/simulator';
import { SIGNATURE_HEADER, verifySignature } from '@app/whatsapp';
import { Redis } from 'ioredis';
import { MockChatModel, MockEmbedder, type ChatModel } from '@app/assistant';
import { ProviderRegistry } from '../src/config.js';
import { RedisEventPublisher } from '../src/events.js';
import type { PipelineDeps } from '../src/deps.js';
import { ingestWebhook } from '../src/ingest.js';
import { createQueues } from '../src/queues.js';
import { LocalDiskStorage } from '../src/storage.js';
import { startWorkers, type RunningWorkers } from '../src/workers.js';

const SECRET = 'test-app-secret';
const TOKEN = 'test-access-token';

export interface TestTenant {
  id: string;
  channelId: string;
  phoneNumberId: string;
  ownerId: string;
  agentId: string;
}

export interface TestCustomer {
  id: string;
  bsuid: string;
  waId: string | null;
}

export interface Harness {
  deps: PipelineDeps;
  sim: Simulator;
  workers: RunningWorkers;
  /** Bypasses RLS: for arranging data and asserting on it. */
  migrator: DbHandle;
  tenant: TestTenant;
  customers: TestCustomer[];
  storageDir: string;
  redisUrl: string;
  /** Another tenant on the same platform, for isolation tests. */
  createTenant(): Promise<TestTenant>;
  close(): Promise<void>;
}

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

export async function createTenant(migrator: DbHandle): Promise<TestTenant> {
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await migrator.db
    .insert(schema.tenants)
    .values({ slug: `pipe-${suffix}`, name: `Pipeline ${suffix}`, timezone: 'Asia/Dubai' })
    .returning();
  const users = await migrator.db
    .insert(schema.users)
    .values([
      { name: 'Owner', email: `owner-${suffix}@test.example` },
      { name: 'Agent', email: `agent-${suffix}@test.example` },
    ])
    .returning();
  await migrator.db.insert(schema.memberships).values([
    { tenantId: tenant!.id, userId: users[0]!.id, role: 'owner' },
    { tenantId: tenant!.id, userId: users[1]!.id, role: 'agent' },
  ]);
  const phoneNumberId = `1${digits(14)}`;
  const [channel] = await migrator.db
    .insert(schema.channels)
    .values({
      tenantId: tenant!.id,
      provider: 'simulator',
      phoneNumberId,
      displayPhoneNumber: `+971 4 ${digits(3)} ${digits(4)}`,
    })
    .returning();
  return {
    id: tenant!.id,
    channelId: channel!.id,
    phoneNumberId,
    ownerId: users[0]!.id,
    agentId: users[1]!.id,
  };
}

export interface HarnessOptions {
  faults?: Partial<FaultSettings>;
  customers?: number;
  orderHoldMs?: number;
  outboundAttempts?: number;
  outboundBackoffMs?: number;
  statusStepMs?: number;
  seed?: number;
  /** Off by default, so pipeline tests see only the replies they send. */
  assistant?: { model?: ChatModel };
}

/**
 * The production wiring, in one process: simulator → webhook receiver (same
 * steps as the API endpoint: verify signature, store, enqueue) → BullMQ →
 * workers → Postgres as app_user → simulator's Graph API.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const urls = testDatabaseUrls();
  const migrator = createDb(urls.migrator, { max: 3 });
  const app = createDb(urls.user, { max: 10 });
  const tenant = await createTenant(migrator);

  const redisUrl = process.env['TEST_REDIS_URL'];
  if (!redisUrl) throw new Error('TEST_REDIS_URL is not set');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const prefix = `t${randomUUID().slice(0, 8)}`;
  const settings = {
    orderHoldMs: options.orderHoldMs ?? 300,
    outboundAttempts: options.outboundAttempts ?? 8,
    outboundBackoffMs: options.outboundBackoffMs ?? 20,
  };
  const queues = createQueues(connection, settings, prefix);

  // Webhook receiver: what WhatsAppWebhookController does, without Nest.
  const receiver: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (!verifySignature(body, req.headers[SIGNATURE_HEADER] as string | undefined, SECRET)) {
        res.statusCode = 401;
        res.end();
        return;
      }
      ingestWebhook(app.db, queues, 'simulator', body.toString('utf8')).then(
        () => {
          res.statusCode = 200;
          res.end();
        },
        () => {
          res.statusCode = 500;
          res.end();
        },
      );
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const webhookUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/hook`;

  const sim: Simulator = createSimulator({
    webhookUrl,
    appSecret: SECRET,
    accessToken: TOKEN,
    random: seededRandom(options.seed ?? 7),
    statusStepMs: options.statusStepMs ?? 20,
    seedDemo: false,
    ...(options.faults ? { faults: options.faults } : {}),
  });
  sim.state.businesses.set(tenant.phoneNumberId, {
    phoneNumberId: tenant.phoneNumberId,
    displayPhoneNumber: '+971 4 000 0000',
    name: 'Test business',
  });
  const customers: TestCustomer[] = [];
  for (let i = 0; i < (options.customers ?? 3); i++) {
    // Every third customer has a username and no phone number.
    const waId = i % 3 === 2 ? null : `9715${digits(8)}`;
    const customer = sim.state.addCustomer({
      name: `Customer ${String(i + 1)}`,
      bsuid: `AE.${digits(20)}`,
      waId,
      businessPhoneNumberId: tenant.phoneNumberId,
    });
    customers.push({ id: customer.id, bsuid: customer.bsuid, waId });
  }
  const simServer = await sim.listen(0);

  const storageDir = await mkdtemp(join(tmpdir(), 'desk-media-'));
  const publisher = new Redis(redisUrl);
  const deps: PipelineDeps = {
    db: app.db,
    queues,
    providers: new ProviderRegistry({
      simulator: {
        baseUrl: simServer.url,
        graphVersion: 'v26.0',
        accessToken: TOKEN,
        appSecret: SECRET,
        verifyToken: 'unused',
      },
    }),
    storage: new LocalDiskStorage(storageDir),
    logger: createLogger({
      service: 'pipeline-test',
      level: 'error',
      destination: new Writable({
        write: (_c, _e, done) => {
          done();
        },
      }),
    }),
    settings,
    assistant: {
      model: options.assistant?.model ?? new MockChatModel(),
      embedder: new MockEmbedder(),
      settings: { enabled: Boolean(options.assistant), debounceMs: 0, maxOutputTokens: 1024 },
    },
    events: new RedisEventPublisher(
      publisher,
      createLogger({ service: 'events-test', level: 'error' }),
    ),
  };
  const workers = startWorkers(deps, {
    connection,
    prefix,
    sweepIntervalMs: 1_000,
    sweepAfterSeconds: 2,
  });

  return {
    deps,
    sim,
    workers,
    migrator,
    tenant,
    customers,
    storageDir,
    redisUrl,
    createTenant: () => createTenant(migrator),
    close: async () => {
      await workers.close();
      await queues.close();
      await simServer.close();
      await new Promise<void>((resolve) => {
        receiver.close(() => {
          resolve();
        });
      });
      connection.disconnect();
      publisher.disconnect();
      await Promise.all([app.close(), migrator.close()]);
    },
  };
}

/** Polls until `check` returns true, or fails with `what` after `timeoutMs`. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
