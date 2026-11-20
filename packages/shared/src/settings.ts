import { z } from 'zod';
import { tenantRoleSchema } from './api.js';
import { openingHoursSchema } from './hours.js';

/** Languages a business can serve; Transcribe and Polly cover these (D-072). */
export const BUSINESS_LANGUAGES = ['en', 'ar', 'hi', 'ml'] as const;
export const businessLanguageSchema = z.enum(BUSINESS_LANGUAGES);
export type BusinessLanguage = z.infer<typeof businessLanguageSchema>;

export const LANGUAGE_LABELS: Record<BusinessLanguage, string> = {
  en: 'English',
  ar: 'Arabic',
  hi: 'Hindi',
  ml: 'Malayalam',
};

export const assistantToneSchema = z.enum(['warm', 'brief', 'formal']);
export type AssistantToneSetting = z.infer<typeof assistantToneSchema>;

/** Each settings section is saved on its own, and each save is audited. */
export const SETTINGS_SECTIONS = [
  'business',
  'hours',
  'assistant',
  'escalation',
  'voice',
  'templates',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const timeZone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be an IANA time zone, e.g. Asia/Dubai' },
);

export const businessSettingsSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  /** What the business sells and where: the assistant stays on this topic. */
  summary: z.string().trim().min(10).max(600),
  timezone: timeZone,
});

export const hoursSettingsSchema = z.strictObject({
  /** Null: hours not set, so nothing is ever "after hours". */
  hours: openingHoursSchema.nullable(),
});

export const assistantSettingsSchema = z.strictObject({
  tone: assistantToneSchema,
  dailyTokenBudget: z.number().int().min(10_000).max(10_000_000),
  turnsPerCustomerHour: z.number().int().min(1).max(200),
});

export const escalationSettingsSchema = z.strictObject({
  /** Words or short phrases; any script. */
  keywords: z.array(z.string().trim().min(2).max(40)).max(30),
  maxAssistantReplies: z.number().int().min(1).max(50).nullable(),
  outsideHoursNotice: z.boolean(),
});

export const voiceSettingsSchema = z.strictObject({
  languages: z
    .array(businessLanguageSchema)
    .min(1, 'choose at least one language')
    .refine((l) => new Set(l).size === l.length, 'each language once'),
  voiceReplies: z.boolean(),
});

/** Approved WhatsApp template names, per language (P-05). Meta's own naming rule. */
export const templatesSettingsSchema = z.strictObject({
  reopen: z.partialRecord(
    businessLanguageSchema,
    z
      .string()
      .trim()
      .regex(
        /^[a-z0-9_]{1,512}$/,
        'lowercase letters, digits and underscores, as in WhatsApp Manager',
      ),
  ),
});

const changed = z
  .object({ at: z.iso.datetime({ offset: true }), by: z.string().nullable() })
  .nullable();

/** What the API returns: stored values, without the input rules (older rows may predate them). */
export const tenantSettingsSchema = z.object({
  business: z.object({ name: z.string(), summary: z.string(), timezone: z.string() }),
  hours: openingHoursSchema.nullable(),
  assistant: assistantSettingsSchema,
  escalation: escalationSettingsSchema,
  voice: voiceSettingsSchema,
  templates: templatesSettingsSchema,
  /** The last change to each section, from the audit log. */
  lastChanged: z.record(z.enum(SETTINGS_SECTIONS), changed),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

// --- staff -------------------------------------------------------------------------

export const staffInviteBodySchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(200),
  role: tenantRoleSchema,
});
export type StaffInviteBody = z.infer<typeof staffInviteBodySchema>;

export const staffSchema = z.object({
  members: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      email: z.string(),
      role: tenantRoleSchema,
    }),
  ),
  invites: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.string(),
      role: tenantRoleSchema,
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ),
});
export type Staff = z.infer<typeof staffSchema>;

/** A one-time link to hand over by hand (no email in v1, P-03). Shown once. */
export const staffLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type StaffLink = z.infer<typeof staffLinkSchema>;

/** Passwords: the same bounds sign-in enforces (apps/api auth: 12 to 128). */
export const newPasswordSchema = z.string().min(12, 'use at least 12 characters').max(128);

export const linkInfoSchema = z.object({
  kind: z.enum(['invite', 'reset']),
  business: z.string(),
  name: z.string(),
  email: z.string(),
});
export type LinkInfo = z.infer<typeof linkInfoSchema>;

export const acceptInviteBodySchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  password: newPasswordSchema,
});
export const resetPasswordBodySchema = z.strictObject({ password: newPasswordSchema });
