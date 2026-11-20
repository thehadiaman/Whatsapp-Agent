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
  /** Set when the tenant is created only: afterwards they are the owner's settings. */
  languages?: string[];
  voiceReplies?: boolean;
  settings?: Partial<typeof schema.tenants.$inferInsert> | undefined;
  members: (SeedUser & { role: TenantRole })[];
  /** A WhatsApp number on the simulator (provider `simulator`). */
  channel?: { phoneNumberId: string; displayPhoneNumber: string };
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
    .values({
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      ...(tenant.languages ? { languages: tenant.languages } : {}),
      ...(tenant.voiceReplies === undefined ? {} : { voiceReplies: tenant.voiceReplies }),
      ...tenant.settings,
    })
    .onConflictDoUpdate({
      target: schema.tenants.slug,
      set: { name: tenant.name, timezone: tenant.timezone, updatedAt: new Date() },
    })
    .returning({ id: schema.tenants.id });
  if (!row) throw new Error(`seed: could not upsert tenant ${tenant.slug}`);

  if (tenant.channel) {
    await db
      .insert(schema.channels)
      .values({
        tenantId: row.id,
        provider: 'simulator',
        phoneNumberId: tenant.channel.phoneNumberId,
        displayPhoneNumber: tenant.channel.displayPhoneNumber,
      })
      .onConflictDoNothing();
  }

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

const open = (from: string, to: string) => ({ open: from, close: to });

/** Each demo business's settings when it is created (owners change them after). */
const DEMO_SETTINGS: Record<string, Partial<typeof schema.tenants.$inferInsert>> = {
  // Karama, Dubai: open every day; Friday opens after the midday prayer.
  'qamar-phone-corner': {
    openingHours: {
      mon: open('10:00', '22:00'),
      tue: open('10:00', '22:00'),
      wed: open('10:00', '22:00'),
      thu: open('10:00', '22:00'),
      fri: open('14:00', '22:00'),
      sat: open('10:00', '22:00'),
      sun: open('12:00', '22:00'),
    },
    assistantTone: 'warm',
    escalationKeywords: ['refund', 'complaint', 'police', 'استرداد', 'शिकायत'],
    reopenTemplates: {
      en: 'reopen_conversation',
      ar: 'reopen_conversation_ar',
      hi: 'reopen_conversation_hi',
    },
  },
  // Kochi: a home bakery, closed on Sundays.
  'kayal-bakes': {
    openingHours: {
      mon: open('09:00', '20:00'),
      tue: open('09:00', '20:00'),
      wed: open('09:00', '20:00'),
      thu: open('09:00', '20:00'),
      fri: open('09:00', '20:00'),
      sat: open('09:00', '20:00'),
      sun: null,
    },
    assistantTone: 'warm',
    escalationKeywords: ['refund', 'complaint', 'allergy', 'പരാതി'],
    reopenTemplates: { en: 'reopen_conversation', ml: 'reopen_conversation_ml' },
  },
};

/** The demo businesses from @app/shared, with a password for every member. */
export function demoTenants(password: string): SeedTenant[] {
  return DEMO_BUSINESSES.map((business) => ({
    slug: business.slug,
    name: business.name,
    timezone: business.timezone,
    languages: [...business.languages],
    voiceReplies: business.voiceReplies,
    settings: DEMO_SETTINGS[business.slug],
    channel: business.channel,
    members: business.staff.map((person) => ({ ...person, password })),
  }));
}
