import { schema, type Database } from '@app/db';
import { DEMO_BUSINESSES, type TenantRole } from '@app/shared';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';

export interface SeedUser {
  name: string;
  email: string;
  password: string;
}

export interface SeedTenant {
  slug: string;
  name: string;
  timezone: string;
  members: (SeedUser & { role: TenantRole })[];
}

/**
 * Creates or updates a user with an email/password credential, the same rows
 * Better Auth writes on sign-up. Idempotent by email. Must run as app_migrator.
 */
export async function upsertUser(
  db: Database,
  user: SeedUser & { platformRole?: 'admin' },
): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({
      name: user.name,
      email: user.email,
      emailVerified: true,
      platformRole: user.platformRole ?? null,
    })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { name: user.name, platformRole: user.platformRole ?? null, updatedAt: new Date() },
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error(`seed: could not upsert ${user.email}`);

  const password = await hashPassword(user.password);
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, row.id));
  await db.insert(schema.accounts).values({
    userId: row.id,
    accountId: row.id,
    providerId: 'credential',
    password,
  });
  return row.id;
}

/** Creates or updates a tenant and its members. Idempotent by slug and email. */
export async function upsertTenant(db: Database, tenant: SeedTenant): Promise<string> {
  const [row] = await db
    .insert(schema.tenants)
    .values({ slug: tenant.slug, name: tenant.name, timezone: tenant.timezone })
    .onConflictDoUpdate({
      target: schema.tenants.slug,
      set: { name: tenant.name, timezone: tenant.timezone, updatedAt: new Date() },
    })
    .returning({ id: schema.tenants.id });
  if (!row) throw new Error(`seed: could not upsert tenant ${tenant.slug}`);

  for (const member of tenant.members) {
    const userId = await upsertUser(db, member);
    await db
      .insert(schema.memberships)
      .values({ tenantId: row.id, userId, role: member.role })
      .onConflictDoUpdate({
        target: [schema.memberships.tenantId, schema.memberships.userId],
        set: { role: member.role },
      });
  }
  return row.id;
}

/** The demo businesses from @app/shared, with a password for every member. */
export function demoTenants(password: string): SeedTenant[] {
  return DEMO_BUSINESSES.map((business) => ({
    slug: business.slug,
    name: business.name,
    timezone: business.timezone,
    members: business.staff.map((person) => ({ ...person, password })),
  }));
}
