import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockEmbedder } from '@app/assistant';
import { createDb, schema, withTenant, type DbHandle } from '@app/db';
import { testDatabaseUrls } from '@app/db/testing';
import { LocalDiskStorage, retrievePassages } from '@app/pipeline';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedConversations } from './conversations.js';
import { seedKnowledge } from './knowledge.js';
import { demoTenants, upsertTenant } from './seed.js';

let migrator: DbHandle;
let app: DbHandle;
let storage: LocalDiskStorage;
const tenantIds: Record<string, string> = {};

async function counts() {
  const sources = await migrator.db.select().from(schema.knowledgeSources);
  const orders = await migrator.db.select().from(schema.orders);
  return { sources: sources.length, orders: orders.length };
}

beforeAll(async () => {
  migrator = createDb(testDatabaseUrls().migrator, { max: 2 });
  app = createDb(testDatabaseUrls().user, { max: 2 });
  storage = new LocalDiskStorage(await mkdtemp(join(tmpdir(), 'seed-')));
  for (const tenant of demoTenants('seed-test-password')) {
    tenantIds[tenant.slug] = await upsertTenant(migrator.db, tenant);
  }
  await seedConversations(migrator.db, { bulk: 0 });
  await seedKnowledge(migrator.db, storage);
});

afterAll(async () => {
  await Promise.all([migrator.close(), app.close()]);
});

describe('demo knowledge and orders', () => {
  it('gives each business ready sources and an assistant summary', async () => {
    for (const id of Object.values(tenantIds)) {
      const sources = await migrator.db
        .select()
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.tenantId, id));
      expect(sources.length).toBeGreaterThan(3);
      expect(sources.every((s) => s.status === 'ready' && s.passageCount > 0)).toBe(true);
      const [tenant] = await migrator.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, id));
      expect(tenant?.assistantSummary).not.toBe('');
    }
    const [catalogue] = await migrator.db
      .select()
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.title, 'Price list November.csv'));
    expect(catalogue).toMatchObject({ kind: 'catalogue', unitCount: 10, passageCount: 10 });
    expect(await storage.get(catalogue!.storageKey!)).not.toBeNull();
  });

  it('agrees with the seeded conversations', async () => {
    const orders = await migrator.db.select().from(schema.orders);
    const kb2291 = orders.find((o) => o.orderNumber === 'KB-2291');
    // "Shipped with Aramex; the courier has not given a delivery date."
    expect(kb2291).toMatchObject({ status: 'shipped', courier: 'Aramex', promisedDate: null });
    const [fatima] = await migrator.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, kb2291!.customerId!));
    expect(fatima?.profileName).toBe('Fatima Al Mansoori');
    // "I couldn't find KB-2302."
    expect(orders.find((o) => o.orderNumber === 'KB-2302')).toBeUndefined();
  });

  it('retrieval finds the seeded price as a business sees it', async () => {
    const kayal = tenantIds['kayal-bakes']!;
    const passages = await withTenant(app.db, kayal, (tx) =>
      retrievePassages(tx, new MockEmbedder(), 'eggless chocolate truffle cake price'),
    );
    expect(passages.map((p) => p.text).join(' ')).toContain('Price (INR): 850');
  });

  it('is idempotent', async () => {
    const before = await counts();
    await seedKnowledge(migrator.db, storage);
    expect(await counts()).toEqual(before);
  });
});
