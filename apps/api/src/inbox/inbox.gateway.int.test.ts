import { randomInt } from 'node:crypto';
import { schema, type DbHandle } from '@app/db';
import { RedisEventPublisher } from '@app/pipeline';
import { createLogger, INBOX_EVENT, INBOX_SOCKET_PATH, type InboxEvent } from '@app/shared';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrangeDb,
  createTestTenant,
  ORIGIN,
  signIn,
  startApi,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

// Brief §4: tenant A cannot read tenant B's data through the WebSocket.

let api: RunningApi;
let db: DbHandle;
let a: TestTenant;
let b: TestTenant;
let conversationA: string;
const sockets: Socket[] = [];

const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');

function connect(
  cookie: string | null,
  origin: string = ORIGIN,
  options: { transport?: 'websocket' | 'polling'; headers?: Record<string, string> } = {},
): Socket {
  const socket = io(api.url, {
    path: INBOX_SOCKET_PATH,
    addTrailingSlash: false,
    transports: [options.transport ?? 'websocket'],
    reconnection: false,
    extraHeaders: options.headers ?? { origin, ...(cookie ? { cookie } : {}) },
  });
  sockets.push(socket);
  return socket;
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', reject);
  });
}

function refused(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      reject(new Error('connected but should have been refused'));
    });
    socket.once('connect_error', (error) => {
      resolve(error.message);
    });
  });
}

function collect(socket: Socket): InboxEvent[] {
  const events: InboxEvent[] = [];
  socket.on(INBOX_EVENT, (event: InboxEvent) => events.push(event));
  return events;
}

beforeAll(async () => {
  db = arrangeDb();
  a = await createTestTenant(db, 'wsa');
  b = await createTestTenant(db, 'wsb');
  const [channel] = await db.db
    .insert(schema.channels)
    .values({
      tenantId: a.id,
      provider: 'simulator',
      phoneNumberId: `1${digits(14)}`,
      displayPhoneNumber: '+971 4 0',
    })
    .returning();
  const [customer] = await db.db
    .insert(schema.customers)
    .values({ tenantId: a.id, bsuid: `AE.${digits(20)}`, profileName: 'Rahul' })
    .returning();
  const [conversation] = await db.db
    .insert(schema.conversations)
    .values({ tenantId: a.id, channelId: channel!.id, customerId: customer!.id, number: 1 })
    .returning();
  conversationA = conversation!.id;
  api = await startApi();
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await api.close();
  await db.close();
});

describe('handshake', () => {
  it('refuses a connection without a session', async () => {
    expect(await refused(connect(null))).toBe('unauthorized');
  });

  it('refuses a signed-in user from another origin', async () => {
    const cookie = await signIn(api, a.agentEmail);
    expect(await refused(connect(cookie, 'https://evil.example'))).toBe('forbidden origin');
  });

  // Browsers send no Origin on a same-origin GET, which is what the polling
  // handshake is. This is the request a real inbox makes in development.
  it('accepts a same-origin polling handshake without an Origin header', async () => {
    const cookie = await signIn(api, a.agentEmail);
    const socket = connect(null, ORIGIN, {
      transport: 'polling',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    await connected(socket);
  });

  it('refuses a cross-site request that carries no Origin header', async () => {
    const cookie = await signIn(api, a.agentEmail);
    const socket = connect(null, ORIGIN, {
      transport: 'polling',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(await refused(socket)).toBe('forbidden origin');
  });
});

describe('isolation', () => {
  it('a change made through the API reaches its business only', async () => {
    const [cookieA, cookieB] = await Promise.all([
      signIn(api, a.agentEmail),
      signIn(api, b.ownerEmail),
    ]);
    const socketA = connect(cookieA);
    const socketB = connect(cookieB);
    await Promise.all([connected(socketA), connected(socketB)]);
    const eventsA = collect(socketA);
    const eventsB = collect(socketB);

    const response = await fetch(`${api.url}/api/conversations/${conversationA}/take-over`, {
      method: 'POST',
      headers: { cookie: cookieA, origin: ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);

    await expect.poll(() => eventsA.length, { timeout: 3_000 }).toBeGreaterThan(0);
    expect(eventsA[0]).toEqual({ conversationId: conversationA });
    await new Promise((r) => setTimeout(r, 300));
    expect(eventsB).toEqual([]);
  });

  it('an event from a background job for business A never reaches business B', async () => {
    const [cookieA, cookieB] = await Promise.all([
      signIn(api, a.ownerEmail),
      signIn(api, b.ownerEmail),
    ]);
    const socketA = connect(cookieA);
    const socketB = connect(cookieB);
    await Promise.all([connected(socketA), connected(socketB)]);
    const eventsA = collect(socketA);
    const eventsB = collect(socketB);

    // What the worker does after storing a message.
    const redis = new Redis(process.env['TEST_REDIS_URL'] ?? '');
    try {
      await new RedisEventPublisher(
        redis,
        createLogger({ service: 't', level: 'error' }),
      ).conversationChanged(a.id, conversationA);
      await expect.poll(() => eventsA.length, { timeout: 3_000 }).toBe(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(eventsB).toEqual([]);
    } finally {
      redis.disconnect();
    }
  });
});
