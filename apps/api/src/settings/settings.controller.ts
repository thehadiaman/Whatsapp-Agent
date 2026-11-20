import { schema, type Transaction } from '@app/db';
import {
  assistantSettingsSchema,
  businessSettingsSchema,
  escalationSettingsSchema,
  hoursSettingsSchema,
  SETTINGS_SECTIONS,
  templatesSettingsSchema,
  voiceSettingsSchema,
  type BusinessLanguage,
  type SettingsSection,
  type TenantSettings,
} from '@app/shared';
import { Body, Controller, Get, NotFoundException, Put } from '@nestjs/common';
import { desc, eq, like } from 'drizzle-orm';
import type { z } from 'zod';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';

type Tenant = typeof schema.tenants.$inferSelect;

/** Each section, read from the tenant row. */
function sectionsOf(t: Tenant): Omit<TenantSettings, 'lastChanged'> {
  return {
    business: { name: t.name, summary: t.assistantSummary, timezone: t.timezone },
    hours: t.openingHours,
    assistant: {
      tone: t.assistantTone,
      dailyTokenBudget: t.assistantDailyTokenBudget,
      turnsPerCustomerHour: t.assistantTurnsPerCustomerHour,
    },
    escalation: {
      keywords: t.escalationKeywords,
      maxAssistantReplies: t.maxAssistantReplies,
      outsideHoursNotice: t.outsideHoursNotice,
    },
    voice: { languages: t.languages as BusinessLanguage[], voiceReplies: t.voiceReplies },
    templates: { reopen: t.reopenTemplates },
  };
}

const actionOf = (section: SettingsSection) => `settings.${section}.updated`;

/**
 * The business's settings (brief §2.8). Everyone in the business can read
 * them; only the owner changes them. Every change is one audit entry with the
 * section before and after.
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get()
  @Access('member')
  read(@CurrentMember() member: MemberPrincipal): Promise<TenantSettings> {
    return this.tenantDb.run(member, (tx) => this.load(tx));
  }

  @Put('business')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  business(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(businessSettingsSchema)) body: z.infer<typeof businessSettingsSchema>,
  ): Promise<TenantSettings> {
    return this.save(member, 'business', {
      name: body.name,
      assistantSummary: body.summary,
      timezone: body.timezone,
    });
  }

  @Put('hours')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  hours(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(hoursSettingsSchema)) body: z.infer<typeof hoursSettingsSchema>,
  ): Promise<TenantSettings> {
    return this.save(member, 'hours', { openingHours: body.hours });
  }

  @Put('assistant')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  assistant(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(assistantSettingsSchema)) body: z.infer<typeof assistantSettingsSchema>,
  ): Promise<TenantSettings> {
    return this.save(member, 'assistant', {
      assistantTone: body.tone,
      assistantDailyTokenBudget: body.dailyTokenBudget,
      assistantTurnsPerCustomerHour: body.turnsPerCustomerHour,
    });
  }

  @Put('escalation')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  escalation(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(escalationSettingsSchema)) body: z.infer<typeof escalationSettingsSchema>,
  ): Promise<TenantSettings> {
    // One entry per word, whatever the owner typed twice.
    const seen = new Set<string>();
    const keywords = body.keywords.filter((k) => {
      const key = k.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.save(member, 'escalation', {
      escalationKeywords: keywords,
      maxAssistantReplies: body.maxAssistantReplies,
      outsideHoursNotice: body.outsideHoursNotice,
    });
  }

  @Put('voice')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  voice(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(voiceSettingsSchema)) body: z.infer<typeof voiceSettingsSchema>,
  ): Promise<TenantSettings> {
    return this.save(member, 'voice', {
      languages: body.languages,
      voiceReplies: body.voiceReplies,
    });
  }

  @Put('templates')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  templates(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(templatesSettingsSchema)) body: z.infer<typeof templatesSettingsSchema>,
  ): Promise<TenantSettings> {
    return this.save(member, 'templates', { reopenTemplates: body.reopen });
  }

  /** Updates one section and records it, in one transaction. */
  private save(
    member: MemberPrincipal,
    section: SettingsSection,
    values: Partial<typeof schema.tenants.$inferInsert>,
  ): Promise<TenantSettings> {
    return this.tenantDb.run(member, async (tx) => {
      const [before] = await tx.select().from(schema.tenants);
      if (!before) throw new NotFoundException('Business account not found.');
      const [after] = await tx
        .update(schema.tenants)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.tenants.id, member.tenantId))
        .returning();
      if (!after) throw new NotFoundException('Business account not found.');
      await this.tenantDb.audit(tx, member, {
        action: actionOf(section),
        targetType: 'tenant',
        targetId: member.tenantId,
        before: sectionsOf(before)[section],
        after: sectionsOf(after)[section],
      });
      return this.load(tx);
    });
  }

  private async load(tx: Transaction): Promise<TenantSettings> {
    const [tenant] = await tx.select().from(schema.tenants);
    if (!tenant) throw new NotFoundException('Business account not found.');
    // Newest first; the first entry seen for each section is its last change.
    const entries = await tx
      .select({
        action: schema.auditLog.action,
        at: schema.auditLog.createdAt,
        by: schema.users.name,
      })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
      .where(like(schema.auditLog.action, 'settings.%'))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(500);
    const lastChanged = Object.fromEntries(
      SETTINGS_SECTIONS.map((section) => {
        const entry = entries.find((e) => e.action === actionOf(section));
        return [section, entry ? { at: entry.at.toISOString(), by: entry.by } : null];
      }),
    ) as TenantSettings['lastChanged'];
    return { ...sectionsOf(tenant), lastChanged };
  }
}
