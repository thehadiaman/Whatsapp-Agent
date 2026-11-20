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
  type WhatsappNumberBody,
  type WhatsappNumbers,
  whatsappNumberBodySchema,
} from '@app/shared';
import { channelTokenContext, type ProviderRegistry } from '@app/pipeline';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Put,
} from '@nestjs/common';
import { desc, eq, like } from 'drizzle-orm';
import type { z } from 'zod';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodBody } from '../common/zod-body.pipe.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { PROVIDERS } from '../infra/tokens.js';
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
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PROVIDERS) private readonly providers: ProviderRegistry,
  ) {}

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

  /** The business's WhatsApp numbers: the simulator's, and its own Meta number (P-04). */
  @Get('whatsapp')
  @Access('owner')
  whatsapp(@CurrentMember() member: MemberPrincipal): Promise<WhatsappNumbers> {
    return this.tenantDb.run(member, (tx) => this.numbers(tx));
  }

  @Put('whatsapp')
  @Access('owner')
  @RateLimit({ name: 'settings', limit: 30, windowSeconds: 60 })
  async connect(
    @CurrentMember() member: MemberPrincipal,
    @Body(new ZodBody(whatsappNumberBodySchema)) body: WhatsappNumberBody,
  ): Promise<WhatsappNumbers> {
    if (this.config.APP_MODE !== 'live') {
      throw new ConflictException(
        'This desk runs in mock mode: customers write through the simulator. Connect a WhatsApp number in live mode.',
      );
    }
    const box = this.providers.secrets;
    if (!box) {
      throw new ConflictException(
        "WhatsApp tokens can't be stored: the server has no CREDENTIALS_KEY. Ask whoever runs it.",
      );
    }
    const sealed = body.accessToken
      ? box.seal(body.accessToken, channelTokenContext(body.phoneNumberId))
      : null;
    return this.tenantDb.run(member, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.provider, 'meta'));
      if (current && current.phoneNumberId !== body.phoneNumberId) {
        throw new ConflictException(
          'This business already has a WhatsApp number. Changing the number itself is not supported yet.',
        );
      }
      if (!current && !sealed) {
        throw new BadRequestException('Paste the access token to connect the number.');
      }
      const values = {
        displayPhoneNumber: body.displayPhoneNumber,
        wabaId: body.wabaId,
        ...(sealed ? { accessTokenSealed: sealed } : {}),
        updatedAt: new Date(),
      };
      if (current) {
        await tx.update(schema.channels).set(values).where(eq(schema.channels.id, current.id));
      } else {
        // Another business's row is hidden by row-level security; the unique
        // constraint on (provider, phone number ID) still catches it.
        const [inserted] = await tx
          .insert(schema.channels)
          .values({
            tenantId: member.tenantId,
            provider: 'meta',
            phoneNumberId: body.phoneNumberId,
            ...values,
          })
          .onConflictDoNothing()
          .returning({ id: schema.channels.id });
        if (!inserted) {
          throw new ConflictException('That number is already connected to another business.');
        }
      }
      // The token itself is never in the audit log; only that it changed.
      await this.tenantDb.audit(tx, member, {
        action: actionOf('whatsapp'),
        targetType: 'tenant',
        targetId: member.tenantId,
        before: current
          ? {
              phoneNumberId: current.phoneNumberId,
              wabaId: current.wabaId,
              displayPhoneNumber: current.displayPhoneNumber,
            }
          : null,
        after: {
          phoneNumberId: body.phoneNumberId,
          wabaId: body.wabaId,
          displayPhoneNumber: body.displayPhoneNumber,
          tokenChanged: sealed !== null,
        },
      });
      return this.numbers(tx);
    });
  }

  private async numbers(tx: Transaction): Promise<WhatsappNumbers> {
    const rows = await tx.select().from(schema.channels);
    return {
      mode: this.config.APP_MODE,
      canConnect: this.config.APP_MODE === 'live' && this.providers.secrets !== null,
      numbers: rows.map((c) => ({
        id: c.id,
        provider: c.provider,
        phoneNumberId: c.phoneNumberId,
        displayPhoneNumber: c.displayPhoneNumber,
        wabaId: c.wabaId,
        tokenSaved: c.accessTokenSealed !== null,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
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
    section: Exclude<SettingsSection, 'whatsapp'>,
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
