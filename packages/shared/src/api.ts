import { z } from 'zod';

/** Request and response shapes shared by the API and the web app. */

export const tenantRoleSchema = z.enum(['owner', 'agent']);
export type TenantRole = z.infer<typeof tenantRoleSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    platformRole: z.enum(['admin']).nullable(),
  }),
  membership: z
    .object({
      tenantId: z.uuid(),
      tenantName: z.string(),
      role: tenantRoleSchema,
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const tenantProfileSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
});
export type TenantProfile = z.infer<typeof tenantProfileSchema>;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Strict: unknown keys (e.g. an `id` or `tenantId` smuggled in the body) are rejected. */
export const updateTenantBodySchema = z
  .strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    timezone: z
      .string()
      .refine(isTimeZone, { message: 'must be an IANA time zone, e.g. Asia/Dubai' })
      .optional(),
  })
  .refine((body) => body.name !== undefined || body.timezone !== undefined, {
    message: 'send at least one of name, timezone',
  });
export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;

export const teamMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.email(),
  role: tenantRoleSchema,
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  actorUserId: z.uuid().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const platformTenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  members: z.number().int(),
});
export type PlatformTenant = z.infer<typeof platformTenantSchema>;

/** Error body for every 4xx/5xx the API returns. */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  issues: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
