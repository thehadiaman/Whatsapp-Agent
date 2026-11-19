import { schema, type DbHandle } from '@app/db';
import {
  updateTenantBodySchema,
  type AuditEntry,
  type MeResponse,
  type PlatformTenant,
  type TeamMember,
  type TenantProfile,
  type UpdateTenantBody,
} from '@app/shared';
import { Body, Controller, Get, Inject, NotFoundException, Patch } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { Access } from '../auth/access.guard.js';
import {
  CurrentMember,
  CurrentPrincipal,
  isMember,
  type MemberPrincipal,
  type Principal,
} from '../auth/principal.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { PLATFORM_DB } from '../infra/tokens.js';
import { TenantDb } from './tenant-db.service.js';

const profileColumns = {
  id: schema.tenants.id,
  slug: schema.tenants.slug,
  name: schema.tenants.name,
  timezone: schema.tenants.timezone,
};

@Controller('me')
export class MeController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get()
  @Access('signed-in')
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    const user = {
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      platformRole: principal.platformRole,
    };
    if (!isMember(principal)) return { user, membership: null };
    const [tenant] = await this.tenantDb.run(principal, (tx) =>
      tx.select({ name: schema.tenants.name }).from(schema.tenants),
    );
    return {
      user,
      membership: {
        tenantId: principal.tenantId,
        tenantName: tenant?.name ?? '',
        role: principal.role,
      },
    };
  }
}

@Controller('tenant')
export class TenantController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get()
  @Access('member')
  async profile(@CurrentMember() member: MemberPrincipal): Promise<TenantProfile> {
    const [tenant] = await this.tenantDb.run(member, (tx) =>
      tx.select(profileColumns).from(schema.tenants),
    );
    if (!tenant) throw new NotFoundException('Business account not found.');
    return tenant;
  }

  /** The tenant is always the caller's own; the body cannot name another one. */
  @Patch()
  @Access('owner')
  update(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(updateTenantBodySchema)) body: UpdateTenantBody,
  ): Promise<TenantProfile> {
    return this.tenantDb.run(member, async (tx) => {
      const [before] = await tx.select(profileColumns).from(schema.tenants);
      if (!before) throw new NotFoundException('Business account not found.');
      const [after] = await tx
        .update(schema.tenants)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.tenants.id, member.tenantId))
        .returning(profileColumns);
      if (!after) throw new NotFoundException('Business account not found.');
      await this.tenantDb.audit(tx, member, {
        action: 'tenant.profile.updated',
        targetType: 'tenant',
        targetId: member.tenantId,
        before: { name: before.name, timezone: before.timezone },
        after: { name: after.name, timezone: after.timezone },
      });
      return after;
    });
  }
}

@Controller('team')
export class TeamController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get()
  @Access('member')
  list(@CurrentMember() member: MemberPrincipal): Promise<TeamMember[]> {
    // memberships is filtered by row-level security; users is joined through it.
    return this.tenantDb.run(member, (tx) =>
      tx
        .select({
          userId: schema.memberships.userId,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.memberships.role,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .orderBy(asc(schema.users.name)),
    );
  }
}

@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get()
  @Access('owner')
  async list(@CurrentMember() member: MemberPrincipal): Promise<AuditEntry[]> {
    const rows = await this.tenantDb.run(member, (tx) =>
      tx.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(100),
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      actorUserId: row.actorUserId,
      before: row.before,
      after: row.after,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

@Controller('admin/tenants')
export class PlatformTenantsController {
  constructor(@Inject(PLATFORM_DB) private readonly platform: DbHandle) {}

  @Get()
  @Access('platform-admin')
  async list(): Promise<PlatformTenant[]> {
    const result = await this.platform.db.execute<{
      id: string;
      slug: string;
      name: string;
      created_at: Date | string;
      members: string;
    }>(sql`select id, slug, name, created_at, members from platform_list_tenants()`);
    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
      members: Number(row.members),
    }));
  }
}

@Controller('admin/dead-letters')
export class DeadLettersController {
  constructor(@Inject(PLATFORM_DB) private readonly platform: DbHandle) {}

  /** Jobs that retrying will not fix, newest first (brief §4: visible to the admin). */
  @Get()
  @Access('platform-admin')
  async list() {
    const result = await this.platform.db.execute<{
      id: string;
      tenant_name: string | null;
      queue: string;
      reference: string;
      reason: string;
      attempts: number;
      failed_at: Date | string;
    }>(sql`select * from platform_list_dead_letters(200)`);
    return result.rows.map((row) => ({
      id: row.id,
      tenantName: row.tenant_name,
      queue: row.queue,
      reference: row.reference,
      reason: row.reason,
      attempts: row.attempts,
      failedAt: new Date(row.failed_at).toISOString(),
    }));
  }
}
