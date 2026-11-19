import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type DbHandle } from '../src/client.js';
import { auditLog, memberships, tenants, users } from '../src/schema.js';
import { testDatabaseUrls } from '../src/testing.js';

// Tenant data is created as app_migrator (which bypasses RLS, like a seed).
// Every assertion runs as app_user, the role the API and worker use.

/**
 * Drizzle wraps driver errors ("Failed query: ..."); the Postgres error is the
 * cause. Assert on its SQLSTATE and message so a test cannot pass for the
 * wrong reason (e.g. a syntax error).
 */
async function expectPgError(query: PromiseLike<unknown>, code: string, message: RegExp) {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'query should have been rejected').toBeDefined();
  const cause = (caught as { cause?: { code?: string; message?: string } }).cause;
  expect(cause?.code).toBe(code);
  expect(cause?.message).toMatch(message);
}

const INSUFFICIENT_PRIVILEGE = '42501';
const RLS_VIOLATION = /violates row-level security policy/;
const PERMISSION_DENIED = /permission denied/;

let migrator: DbHandle;
let app: DbHandle;
let platform: DbHandle;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

beforeAll(async () => {
  const urls = testDatabaseUrls();
  migrator = createDb(urls.migrator, { max: 2 });
  app = createDb(urls.user, { max: 2 });
  platform = createDb(urls.platform, { max: 1 });

  await migrator.db.insert(tenants).values([
    { id: tenantA, slug: `a-${tenantA}`, name: 'Tenant A', timezone: 'Asia/Dubai' },
    { id: tenantB, slug: `b-${tenantB}`, name: 'Tenant B', timezone: 'Asia/Kolkata' },
  ]);
  await migrator.db.insert(users).values([
    { id: userA, name: 'User A', email: `${userA}@a.example` },
    { id: userB, name: 'User B', email: `${userB}@b.example` },
  ]);
  await migrator.db.insert(memberships).values([
    { tenantId: tenantA, userId: userA, role: 'owner' },
    { tenantId: tenantB, userId: userB, role: 'owner' },
  ]);
  await migrator.db.insert(auditLog).values([
    { tenantId: tenantA, action: 'test', targetType: 'tenant', targetId: tenantA },
    { tenantId: tenantB, action: 'test', targetType: 'tenant', targetId: tenantB },
  ]);
});

afterAll(async () => {
  await Promise.all([migrator.close(), app.close(), platform.close()]);
});

describe('every tenant-owned table', () => {
  it('has row-level security enabled and forced (catches a new table without a policy)', async () => {
    const result = await migrator.db.execute<{
      table: string;
      enabled: boolean;
      forced: boolean;
    }>(sql`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by c.relname`);
    // Platform-level tables: no tenant until routed (webhook_events has no
    // tenant_id) or readable only through a platform function (dead_letters).
    const platformLevel = new Set(['dead_letters']);
    const tenantTables = result.rows.filter((row) => !platformLevel.has(row.table));
    expect(tenantTables.length).toBeGreaterThanOrEqual(9);
    for (const row of tenantTables) {
      expect({ table: row.table, enabled: row.enabled, forced: row.forced }).toEqual({
        table: row.table,
        enabled: true,
        forced: true,
      });
    }
  });
});

describe('app_user role', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    const result = await app.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('without a tenant set', () => {
  it('sees no rows in any tenant table (fails closed)', async () => {
    expect(await app.db.select().from(tenants)).toEqual([]);
    expect(await app.db.select().from(memberships)).toEqual([]);
    expect(await app.db.select().from(auditLog)).toEqual([]);
  });

  it('cannot write tenant rows', async () => {
    await expectPgError(
      app.db.insert(auditLog).values({
        tenantId: tenantA,
        action: 'x',
        targetType: 'tenant',
        targetId: tenantA,
      }),
      INSUFFICIENT_PRIVILEGE,
      RLS_VIOLATION,
    );
  });
});

describe('with tenant A set', () => {
  it('reads only tenant A rows, with no WHERE clause', async () => {
    await withTenant(app.db, tenantA, async (tx) => {
      expect((await tx.select().from(tenants)).map((t) => t.id)).toEqual([tenantA]);
      expect((await tx.select().from(memberships)).map((m) => m.tenantId)).toEqual([tenantA]);
      const audit = await tx.select().from(auditLog);
      expect(audit.every((row) => row.tenantId === tenantA)).toBe(true);
    });
  });

  it('cannot read tenant B by asking for it by id', async () => {
    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx.select().from(tenants).where(eq(tenants.id, tenantB)),
    );
    expect(rows).toEqual([]);
  });

  it('cannot update tenant B (zero rows affected, B unchanged)', async () => {
    const updated = await withTenant(app.db, tenantA, (tx) =>
      tx.update(tenants).set({ name: 'hijacked' }).where(eq(tenants.id, tenantB)).returning(),
    );
    expect(updated).toEqual([]);
    const [b] = await migrator.db.select().from(tenants).where(eq(tenants.id, tenantB));
    expect(b?.name).toBe('Tenant B');
  });

  it('cannot insert a row labelled with tenant B', async () => {
    await expectPgError(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(auditLog).values({
          tenantId: tenantB,
          action: 'forged',
          targetType: 'tenant',
          targetId: tenantB,
        }),
      ),
      INSUFFICIENT_PRIVILEGE,
      RLS_VIOLATION,
    );
  });

  it('cannot move its own row to tenant B', async () => {
    await expectPgError(
      withTenant(app.db, tenantA, (tx) =>
        tx.update(tenants).set({ id: tenantB }).where(eq(tenants.id, tenantA)),
      ),
      INSUFFICIENT_PRIVILEGE,
      RLS_VIOLATION,
    );
  });
});

describe('the tenant setting does not leak between transactions', () => {
  it('is gone after the transaction ends, on the same pooled connection', async () => {
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA]);
      expect((await client.query('select id from tenants')).rowCount).toBe(1);
      await client.query('commit');
      expect((await client.query('select id from tenants')).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});

describe('privileges', () => {
  it('app_user cannot delete or rewrite the audit log', async () => {
    await expectPgError(
      withTenant(app.db, tenantA, (tx) =>
        tx.delete(auditLog).where(eq(auditLog.tenantId, tenantA)),
      ),
      INSUFFICIENT_PRIVILEGE,
      PERMISSION_DENIED,
    );
    await expectPgError(
      withTenant(app.db, tenantA, (tx) => tx.update(auditLog).set({ action: 'edited' })),
      INSUFFICIENT_PRIVILEGE,
      PERMISSION_DENIED,
    );
  });

  it('app_user can look up only the membership it asks for', async () => {
    const result = await app.db.execute<{ tenant_id: string; role: string }>(
      sql`select tenant_id, role from auth_membership(${userA})`,
    );
    expect(result.rows).toEqual([{ tenant_id: tenantA, role: 'owner' }]);
  });

  it('app_user cannot call the platform-admin function', async () => {
    await expectPgError(
      app.db.execute(sql`select * from platform_list_tenants()`),
      INSUFFICIENT_PRIVILEGE,
      PERMISSION_DENIED,
    );
  });

  it('app_platform can list tenants but cannot read tenant tables', async () => {
    const result = await platform.db.execute<{ id: string }>(
      sql`select id from platform_list_tenants()`,
    );
    expect(result.rows.map((r) => r.id)).toEqual(expect.arrayContaining([tenantA, tenantB]));
    await expectPgError(
      platform.db.select().from(tenants),
      INSUFFICIENT_PRIVILEGE,
      PERMISSION_DENIED,
    );
  });
});
