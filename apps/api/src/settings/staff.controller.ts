import { createHash, randomBytes } from 'node:crypto';
import { schema, withTenant, type DbHandle, type Transaction } from '@app/db';
import { transitionConversation, type EventPublisher } from '@app/pipeline';
import {
  acceptInviteBodySchema,
  resetPasswordBodySchema,
  staffInviteBodySchema,
  type LinkInfo,
  type Staff,
  type StaffInviteBody,
  type StaffLink,
} from '@app/shared';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { hashPassword } from 'better-auth/crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { currentRequest } from '../common/request-context.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { API_CONFIG, trustedOrigin, type ApiConfig } from '../config.js';
import { InboxGateway } from '../inbox/inbox.gateway.js';
import { DB, EVENTS } from '../infra/tokens.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';

const INVITE_DAYS = 7;
const RESET_HOURS = 1;

/** A link token: 256 random bits in the URL, only its SHA-256 in the database. */
function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Staff accounts without email (P-03): the owner creates a one-time link and
 * hands it over (WhatsApp, in person). Links expire, work once, and are stored
 * only as hashes, so a database leak does not leak working links.
 */
@Controller('staff')
export class StaffController {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(EVENTS) private readonly events: EventPublisher,
    private readonly gateway: InboxGateway,
  ) {}

  @Get()
  @Access('owner')
  list(@CurrentMember() member: MemberPrincipal): Promise<Staff> {
    return this.tenantDb.run(member, async (tx) => {
      const members = await tx
        .select({
          userId: schema.memberships.userId,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.memberships.role,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .orderBy(asc(schema.users.name));
      const invites = await tx
        .select()
        .from(schema.staffInvites)
        .where(
          and(
            isNull(schema.staffInvites.acceptedAt),
            gt(schema.staffInvites.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(schema.staffInvites.createdAt));
      return {
        members,
        invites: invites.map((i) => ({
          id: i.id,
          name: i.name,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt.toISOString(),
        })),
      };
    });
  }

  /** Returns the link once; afterwards only its hash exists. */
  @Post('invites')
  @Access('owner')
  @RateLimit({ name: 'staff', limit: 20, windowSeconds: 60 })
  async invite(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(staffInviteBodySchema)) body: StaffInviteBody,
  ): Promise<StaffLink> {
    const email = body.email.toLowerCase();
    const { token, hash } = newToken();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);
    await this.tenantDb.run(member, async (tx) => {
      const [taken] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      if (taken) {
        throw new ConflictException(
          'Someone with this email already has an account. Each person works for one business.',
        );
      }
      // A new invite replaces an unused one for the same person.
      await tx.delete(schema.staffInvites).where(eq(schema.staffInvites.email, email));
      const [row] = await tx
        .insert(schema.staffInvites)
        .values({
          tenantId: member.tenantId,
          name: body.name,
          email,
          role: body.role,
          tokenHash: hash,
          createdBy: member.userId,
          expiresAt,
        })
        .returning({ id: schema.staffInvites.id });
      await this.tenantDb.audit(tx, member, {
        action: 'staff.invited',
        targetType: 'staff_invite',
        targetId: row?.id ?? '',
        after: { name: body.name, email, role: body.role },
      });
    });
    return {
      url: `${trustedOrigin(this.config)}/join/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  @Delete('invites/:id')
  @Access('owner')
  @HttpCode(204)
  async cancelInvite(
    @CurrentMember() member: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.tenantDb.run(member, async (tx) => {
      const [gone] = await tx
        .delete(schema.staffInvites)
        .where(eq(schema.staffInvites.id, id))
        .returning({ email: schema.staffInvites.email });
      if (!gone) throw new NotFoundException('There is no such invite.');
      await this.tenantDb.audit(tx, member, {
        action: 'staff.invite_cancelled',
        targetType: 'staff_invite',
        targetId: id,
        before: { email: gone.email },
      });
    });
  }

  @Post(':userId/reset-link')
  @Access('owner')
  @RateLimit({ name: 'staff', limit: 20, windowSeconds: 60 })
  async resetLink(
    @CurrentMember() member: MemberPrincipal,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<StaffLink> {
    const { token, hash } = newToken();
    const expiresAt = new Date(Date.now() + RESET_HOURS * 60 * 60 * 1000);
    await this.tenantDb.run(member, async (tx) => {
      await this.requireMember(tx, userId);
      await tx.insert(schema.passwordResets).values({
        tenantId: member.tenantId,
        userId,
        tokenHash: hash,
        createdBy: member.userId,
        expiresAt,
      });
      await this.tenantDb.audit(tx, member, {
        action: 'staff.reset_link_created',
        targetType: 'user',
        targetId: userId,
      });
    });
    return {
      url: `${trustedOrigin(this.config)}/reset/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Removes someone from the business: their membership and sessions go, their
   * open sockets close, and conversations they held wait for another person.
   */
  @Delete(':userId')
  @Access('owner')
  @HttpCode(204)
  @RateLimit({ name: 'staff', limit: 20, windowSeconds: 60 })
  async remove(
    @CurrentMember() member: MemberPrincipal,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    if (userId === member.userId) {
      throw new ConflictException("You can't remove yourself from the team. Another owner can.");
    }
    const released = await this.tenantDb.run(member, async (tx) => {
      const person = await this.requireMember(tx, userId);
      const held = await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.holderUserId, userId),
            eq(schema.conversations.state, 'human'),
          ),
        );
      for (const c of held) {
        await transitionConversation(tx, {
          conversationId: c.id,
          to: 'waiting_for_human',
          actor: { type: 'user', userId: member.userId },
          reason: `${person.name} was removed from the team`,
          requestId: currentRequest()?.requestId ?? null,
        });
      }
      await tx.delete(schema.memberships).where(eq(schema.memberships.userId, userId));
      // Sessions are not tenant-owned; the membership check above proved this user is ours.
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await this.tenantDb.audit(tx, member, {
        action: 'staff.removed',
        targetType: 'user',
        targetId: userId,
        before: { name: person.name, email: person.email, role: person.role },
      });
      return held.map((c) => c.id);
    });
    this.gateway.disconnectUser(userId);
    for (const id of released) await this.events.conversationChanged(member.tenantId, id);
  }

  private async requireMember(tx: Transaction, userId: string) {
    const [person] = await tx
      .select({ name: schema.users.name, email: schema.users.email, role: schema.memberships.role })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.userId, userId));
    if (!person) throw new NotFoundException('That person is not in this business.');
    return person;
  }
}

interface InviteRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: 'owner' | 'agent';
  expires_at: Date;
  accepted_at: Date | null;
}

interface ResetRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

const EXPIRED = 'This link has expired or was already used. Ask the business owner for a new one.';

/**
 * Opening a link, signed out. The token is looked up across tenants by one
 * narrow function; everything else happens inside that tenant.
 */
@Controller('links')
export class LinksController {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  @Get('invite/:token')
  @Access('public')
  @RateLimit({ name: 'links', limit: 60, windowSeconds: 60 })
  async invite(@Param('token') token: string): Promise<LinkInfo> {
    const invite = await this.findInvite(token);
    return {
      kind: 'invite',
      business: await this.businessName(invite.tenant_id),
      name: invite.name,
      email: invite.email,
    };
  }

  @Post('invite/:token')
  @Access('public')
  @HttpCode(201)
  @RateLimit({ name: 'links', limit: 20, windowSeconds: 60 })
  async accept(
    @Param('token') token: string,
    @Body(new ZodBody(acceptInviteBodySchema)) body: z.infer<typeof acceptInviteBodySchema>,
  ): Promise<{ email: string }> {
    const invite = await this.findInvite(token);
    const password = await hashPassword(body.password);
    await withTenant(this.handle.db, invite.tenant_id, async (tx) => {
      // Claim the invite first: of two tabs racing, one wins and one is told it was used.
      const [claimed] = await tx
        .update(schema.staffInvites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(schema.staffInvites.id, invite.id), isNull(schema.staffInvites.acceptedAt)))
        .returning({ id: schema.staffInvites.id });
      if (!claimed) throw new GoneException(EXPIRED);
      const [user] = await tx
        .insert(schema.users)
        .values({ name: body.name, email: invite.email, emailVerified: true })
        .onConflictDoNothing({ target: schema.users.email })
        .returning({ id: schema.users.id });
      if (!user) {
        throw new ConflictException(
          'Someone with this email already has an account. Ask the business owner for help.',
        );
      }
      await tx.insert(schema.accounts).values({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password,
      });
      await tx
        .insert(schema.memberships)
        .values({ tenantId: invite.tenant_id, userId: user.id, role: invite.role });
      await tx.insert(schema.auditLog).values({
        tenantId: invite.tenant_id,
        actorUserId: user.id,
        action: 'staff.joined',
        targetType: 'user',
        targetId: user.id,
        after: { name: body.name, email: invite.email, role: invite.role },
        requestId: currentRequest()?.requestId ?? null,
      });
    });
    return { email: invite.email };
  }

  @Get('reset/:token')
  @Access('public')
  @RateLimit({ name: 'links', limit: 60, windowSeconds: 60 })
  async reset(@Param('token') token: string): Promise<LinkInfo> {
    const reset = await this.findReset(token);
    const person = await withTenant(this.handle.db, reset.tenant_id, async (tx) => {
      const [row] = await tx
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.userId, reset.user_id));
      return row;
    });
    if (!person) throw new GoneException(EXPIRED);
    return {
      kind: 'reset',
      business: await this.businessName(reset.tenant_id),
      name: person.name,
      email: person.email,
    };
  }

  @Post('reset/:token')
  @Access('public')
  @HttpCode(200)
  @RateLimit({ name: 'links', limit: 20, windowSeconds: 60 })
  async useReset(
    @Param('token') token: string,
    @Body(new ZodBody(resetPasswordBodySchema)) body: z.infer<typeof resetPasswordBodySchema>,
  ): Promise<{ email: string }> {
    const reset = await this.findReset(token);
    const password = await hashPassword(body.password);
    return withTenant(this.handle.db, reset.tenant_id, async (tx) => {
      const [claimed] = await tx
        .update(schema.passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.passwordResets.id, reset.id), isNull(schema.passwordResets.usedAt)))
        .returning({ id: schema.passwordResets.id });
      if (!claimed) throw new GoneException(EXPIRED);
      // Still in this business? A removed person's old link does nothing.
      const [person] = await tx
        .select({ email: schema.users.email })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.userId, reset.user_id));
      if (!person) throw new GoneException(EXPIRED);
      await tx
        .update(schema.accounts)
        .set({ password, updatedAt: new Date() })
        .where(
          and(
            eq(schema.accounts.userId, reset.user_id),
            eq(schema.accounts.providerId, 'credential'),
          ),
        );
      // A new password signs the person out everywhere.
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, reset.user_id));
      await tx.insert(schema.auditLog).values({
        tenantId: reset.tenant_id,
        actorUserId: reset.user_id,
        action: 'staff.password_reset',
        targetType: 'user',
        targetId: reset.user_id,
        requestId: currentRequest()?.requestId ?? null,
      });
      return { email: person.email };
    });
  }

  private async findInvite(token: string): Promise<InviteRow> {
    if (!TOKEN.test(token)) throw new GoneException(EXPIRED);
    const result = await this.handle.db.execute<InviteRow>(
      sql`select * from staff_invite_by_token(${hashToken(token)})`,
    );
    const invite = result.rows[0];
    if (!invite || invite.accepted_at || new Date(invite.expires_at) <= new Date()) {
      throw new GoneException(EXPIRED);
    }
    return invite;
  }

  private async findReset(token: string): Promise<ResetRow> {
    if (!TOKEN.test(token)) throw new GoneException(EXPIRED);
    const result = await this.handle.db.execute<ResetRow>(
      sql`select * from password_reset_by_token(${hashToken(token)})`,
    );
    const reset = result.rows[0];
    if (!reset || reset.used_at || new Date(reset.expires_at) <= new Date()) {
      throw new GoneException(EXPIRED);
    }
    return reset;
  }

  private async businessName(tenantId: string): Promise<string> {
    const [tenant] = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select({ name: schema.tenants.name }).from(schema.tenants),
    );
    return tenant?.name ?? 'the business';
  }
}
