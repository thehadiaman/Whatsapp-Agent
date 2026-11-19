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
    // Simulator number; Meta phone number IDs are numeric strings like this.
    channel: { phoneNumberId: '100000000000001', displayPhoneNumber: '+971 4 555 0101' },
    staff: [
      { name: 'Anil Kumar', email: 'anil@qamar.example', role: 'owner' },
      { name: 'Priya Raman', email: 'priya@qamar.example', role: 'agent' },
    ],
  },
  {
    slug: 'kayal-bakes',
    name: 'Kayal Bakes',
    timezone: 'Asia/Kolkata',
    channel: { phoneNumberId: '100000000000002', displayPhoneNumber: '+91 484 555 0102' },
    staff: [
      { name: 'Mariam Thomas', email: 'mariam@kayal.example', role: 'owner' },
      { name: 'Nikhil Varghese', email: 'nikhil@kayal.example', role: 'agent' },
    ],
  },
] as const satisfies readonly {
  slug: string;
  name: string;
  timezone: string;
  channel: { phoneNumberId: string; displayPhoneNumber: string };
  staff: readonly { name: string; email: string; role: TenantRole }[];
}[];

export const DEMO_PLATFORM_ADMIN = { name: 'Platform admin', email: 'admin@desk.example' } as const;

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  ...DEMO_BUSINESSES.flatMap((business) =>
    business.staff.map((person) => ({ ...person, business: business.name })),
  ),
  { ...DEMO_PLATFORM_ADMIN, role: 'platform-admin', business: null },
];

/**
 * Customers the simulator starts with. Fictional; phone numbers use ranges
 * that do not belong to real subscribers. One customer has a username and no
 * phone number, which Meta allows since 2026: the product must cope with a
 * business-scoped user ID alone.
 */
export interface DemoCustomer {
  name: string;
  /** Business-scoped user ID: two-letter country code, a dot, digits. */
  bsuid: string;
  /** Phone number in WhatsApp's format (digits only), or null for username-only users. */
  waId: string | null;
  business: (typeof DEMO_BUSINESSES)[number]['slug'];
}

export const DEMO_CUSTOMERS: readonly DemoCustomer[] = [
  {
    name: 'Fatima Al Mansoori',
    bsuid: 'AE.40000000000000000001',
    waId: '971500000101',
    business: 'qamar-phone-corner',
  },
  {
    name: 'Rahul Nair',
    bsuid: 'AE.40000000000000000002',
    waId: '971500000102',
    business: 'qamar-phone-corner',
  },
  {
    name: 'Mohammed Rafi',
    bsuid: 'AE.40000000000000000003',
    waId: '971500000103',
    business: 'qamar-phone-corner',
  },
  {
    name: 'Aisha Siddiqui',
    bsuid: 'AE.40000000000000000004',
    waId: null,
    business: 'qamar-phone-corner',
  },
  {
    name: 'Sneha Kurian',
    bsuid: 'IN.40000000000000000005',
    waId: '919800000105',
    business: 'kayal-bakes',
  },
  {
    name: 'Joseph Mathew',
    bsuid: 'IN.40000000000000000006',
    waId: '919800000106',
    business: 'kayal-bakes',
  },
];
