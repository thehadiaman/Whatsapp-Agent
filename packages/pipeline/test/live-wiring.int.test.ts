import { randomBytes } from 'node:crypto';
import { schema, withTenant } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/config.js';
import { queueReply } from '../src/outbound.js';
import { enqueueOutbound } from '../src/queues.js';
import { channelTokenContext, SecretBox } from '../src/secrets.js';
import { requeueStaleEmbeddings } from '../src/workers.js';
import { startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h.close();
});

/**
 * A Meta-provider number whose Graph API is the simulator: the same calls,
 * with the token opened from the business's sealed copy (P-04, D-094).
 */
async function metaNumber(sealedToken: string | null) {
  const simulator = h.deps.providers.require('simulator');
  const box = new SecretBox(randomBytes(32));
  h.deps.providers = new ProviderRegistry(
    {
      simulator,
      meta: { ...simulator, accessToken: null },
    },
    box,
  );
  const sealed =
    sealedToken === null
      ? null
      : box.seal(sealedToken, channelTokenContext(h.tenant.phoneNumberId));
  const [channel] = await h.migrator.db
    .insert(schema.channels)
    .values({
      tenantId: h.tenant.id,
      provider: 'meta',
      phoneNumberId: h.tenant.phoneNumberId,
      displayPhoneNumber: '+971 4 555 0199',
      accessTokenSealed: sealed,
    })
    .returning();
  const customer = h.customers[0]!;
  const [row] = await h.migrator.db
    .insert(schema.customers)
    .values({ tenantId: h.tenant.id, bsuid: customer.bsuid, waId: customer.waId })
    .returning();
  // The customer wrote recently, so the window is open.
  h.sim.sendInbound([{ customerId: customer.id, type: 'text', text: 'hello' }]);
  const [conversation] = await h.migrator.db
    .insert(schema.conversations)
    .values({
      tenantId: h.tenant.id,
      channelId: channel!.id,
      customerId: row!.id,
      number: 9_001,
      state: 'human',
      holderUserId: h.tenant.ownerId,
      lastInboundAt: new Date(),
    })
    .returning();
  return conversation!.id;
}

async function reply(conversationId: string, body: string) {
  const id = await withTenant(h.deps.db, h.tenant.id, (tx) =>
    queueReply(tx, {
      conversationId,
      sender: { type: 'user', userId: h.tenant.ownerId },
      content: { kind: 'text', body },
      now: new Date(),
    }),
  );
  await enqueueOutbound(h.deps.queues, { tenantId: h.tenant.id, messageId: id });
  return id;
}

async function message(id: string) {
  const [row] = await h.migrator.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return row!;
}

describe('a business’s own WhatsApp number', () => {
  it('sends with the token opened from its sealed copy', async () => {
    h = await startHarness({ sweepIntervalMs: 3_600_000 });
    const simulatorToken = h.deps.providers.require('simulator').accessToken!;
    const conversationId = await metaNumber(simulatorToken);
    const id = await reply(conversationId, 'Your phone is ready for pickup.');
    await waitFor(
      'sent',
      async () =>
        (await message(id)).status !== 'queued' && (await message(id)).status !== 'sending',
    );
    expect((await message(id)).status).not.toBe('failed');
    expect(h.sim.state.thread(h.customers[0]!.id).at(-1)).toMatchObject({
      direction: 'out',
      text: 'Your phone is ready for pickup.',
    });
  });

  it('a number with no token fails the send with a reason, instead of using another token', async () => {
    h = await startHarness({ sweepIntervalMs: 3_600_000, outboundAttempts: 1 });
    const conversationId = await metaNumber(null);
    const id = await reply(conversationId, 'hello');
    await waitFor('failed', async () => (await message(id)).status === 'failed');
    expect((await message(id)).error?.message).toContain('no access token');
  });
});

describe('changing the embedding model', () => {
  it('re-reads knowledge embedded by another model with the current one', async () => {
    h = await startHarness({ sweepIntervalMs: 3_600_000 });
    const [source] = await h.migrator.db
      .insert(schema.knowledgeSources)
      .values({
        tenantId: h.tenant.id,
        kind: 'faq',
        title: 'Do you open on Fridays?',
        answer: 'Yes, from 2 pm.',
        status: 'ready',
        passageCount: 1,
      })
      .returning();
    await h.migrator.db.insert(schema.knowledgePassages).values({
      tenantId: h.tenant.id,
      sourceId: source!.id,
      ordinal: 0,
      text: 'Do you open on Fridays? Yes, from 2 pm.',
      embedding: Array.from({ length: 1024 }, () => 0.01),
      embeddingModel: 'an-older-model',
    });

    // The worker also checks at start-up; whichever call finds it first queues it.
    await requeueStaleEmbeddings(h.deps);
    await waitFor('re-embedded', async () => {
      const [row] = await h.migrator.db
        .select()
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.id, source!.id));
      return row?.status === 'ready' && row.version === 2;
    });
    const passages = await h.migrator.db
      .select({ model: schema.knowledgePassages.embeddingModel })
      .from(schema.knowledgePassages)
      .where(eq(schema.knowledgePassages.sourceId, source!.id));
    expect(passages).toEqual([{ model: h.deps.assistant.embedder.model }]);
  });
});
