import type { TenantRole } from './api.js';

/**
 * The fictional demo businesses and their staff. The seed creates them and the
 * sign-in page lists them in mock mode, so both read from here.
 */
export interface DemoAccount {
  name: string;
  email: string;
  role: TenantRole | 'platform-admin';
  business: string | null;
}

export const DEMO_DEFAULT_PASSWORD = 'counter-demo-2026';

export const DEMO_BUSINESSES = [
  {
    slug: 'qamar-phone-corner',
    name: 'Qamar Phone Corner',
    timezone: 'Asia/Dubai',
    staff: [
      { name: 'Anil Kumar', email: 'anil@qamar.example', role: 'owner' },
      { name: 'Priya Raman', email: 'priya@qamar.example', role: 'agent' },
    ],
  },
  {
    slug: 'kayal-bakes',
    name: 'Kayal Bakes',
    timezone: 'Asia/Kolkata',
    staff: [
      { name: 'Mariam Thomas', email: 'mariam@kayal.example', role: 'owner' },
      { name: 'Nikhil Varghese', email: 'nikhil@kayal.example', role: 'agent' },
    ],
  },
] as const satisfies readonly {
  slug: string;
  name: string;
  timezone: string;
  staff: readonly { name: string; email: string; role: TenantRole }[];
}[];

export const DEMO_PLATFORM_ADMIN = { name: 'Platform admin', email: 'admin@desk.example' } as const;

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  ...DEMO_BUSINESSES.flatMap((business) =>
    business.staff.map((person) => ({ ...person, business: business.name })),
  ),
  { ...DEMO_PLATFORM_ADMIN, role: 'platform-admin', business: null },
];
