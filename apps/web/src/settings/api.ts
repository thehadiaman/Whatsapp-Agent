import {
  staffLinkSchema,
  staffSchema,
  tenantSettingsSchema,
  type SettingsSection,
  type Staff,
  type StaffInviteBody,
  type StaffLink,
  type TenantSettings,
  type WhatsappNumberBody,
  type WhatsappNumbers,
  whatsappNumbersSchema,
} from '@app/shared';
import { z } from 'zod';
import { request } from '../lib/client-api';

export const settingsApi = {
  read: (): Promise<TenantSettings> => request('/settings', {}, tenantSettingsSchema),
  save: (section: SettingsSection, body: unknown): Promise<TenantSettings> =>
    request(
      `/settings/${section}`,
      { method: 'PUT', body: JSON.stringify(body) },
      tenantSettingsSchema,
    ),
  whatsapp: (): Promise<WhatsappNumbers> =>
    request('/settings/whatsapp', {}, whatsappNumbersSchema),
  connect: (body: WhatsappNumberBody): Promise<WhatsappNumbers> =>
    request(
      '/settings/whatsapp',
      { method: 'PUT', body: JSON.stringify(body) },
      whatsappNumbersSchema,
    ),
  staff: (): Promise<Staff> => request('/staff', {}, staffSchema),
  invite: (body: StaffInviteBody): Promise<StaffLink> =>
    request('/staff/invites', { method: 'POST', body: JSON.stringify(body) }, staffLinkSchema),
  cancelInvite: (id: string) => request(`/staff/invites/${id}`, { method: 'DELETE' }, z.unknown()),
  resetLink: (userId: string): Promise<StaffLink> =>
    request(`/staff/${userId}/reset-link`, { method: 'POST', body: '{}' }, staffLinkSchema),
  remove: (userId: string) => request(`/staff/${userId}`, { method: 'DELETE' }, z.unknown()),
};
