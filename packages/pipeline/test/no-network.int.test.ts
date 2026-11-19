import net from 'node:net';
import { schema, withTenant } from '@app/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { transitionConversation } from '../src/conversations.js';
import { queueReply } from '../src/outbound.js';
import { enqueueOutbound } from '../src/queues.js';
import { startHarness, waitFor, type Harness } from './harness.js';

// Brief §5: mock mode makes zero outbound network calls. Every TCP connection
// this process opens (Postgres, Redis, fetch to the simulator, webhooks) goes
// through net.Socket#connect; record them and allow only loopback.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const connections: string[] = [];
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored in afterAll and always called with the socket as `this`
const original = net.Socket.prototype.connect;

beforeAll(() => {
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const [first, second] = args;
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; path?: string };
      connections.push(options.path ? `unix:${options.path}` : (options.host ?? 'localhost'));
    } else if (typeof first === 'number') {
      connections.push(typeof second === 'string' ? second : 'localhost');
    }
    return Reflect.apply(original, this, args) as net.Socket;
  };
});

let h: Harness;

afterAll(async () => {
  await h.close();
  net.Socket.prototype.connect = original;
});

it('a full inbound and outbound flow connects only to loopback', async () => {
  h = await startHarness();
  const customer = h.customers[0]!;
  h.sim.sendInbound([{ customerId: customer.id, type: 'image', caption: 'photo' }]);
  await waitFor('media stored', async () => {
    const [m] = await h.migrator.db
      .select()
      .from(schema.messages)
      .where(
        and(eq(schema.messages.tenantId, h.tenant.id), eq(schema.messages.direction, 'inbound')),
      );
    return Boolean(m?.media?.storageKey);
  });
  const [conversation] = await h.migrator.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, h.tenant.id));
  const id = await withTenant(h.deps.db, h.tenant.id, async (tx) => {
    await transitionConversation(tx, {
      conversationId: conversation!.id,
      to: 'human',
      actor: { type: 'user', userId: h.tenant.agentId },
      reason: 'test',
    });
    return queueReply(tx, {
      conversationId: conversation!.id,
      sender: { type: 'user', userId: h.tenant.agentId },
      content: { kind: 'text', body: 'Thanks for the photo' },
      now: new Date(),
    });
  });
  await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
  await waitFor('reply delivered', async () => {
    const [m] = await h.migrator.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, id));
    return m?.status === 'delivered';
  });

  expect(connections.length).toBeGreaterThan(0);
  const external = connections.filter((host) => !LOOPBACK.has(host) && !host.startsWith('unix:'));
  expect(external).toEqual([]);
});
