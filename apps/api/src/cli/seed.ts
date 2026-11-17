import { createDb } from '@app/db';
import {
  DEMO_DEFAULT_PASSWORD,
  DEMO_PLATFORM_ADMIN,
  nodeEnvSchema,
  parseEnv,
  postgresUrlSchema,
} from '@app/shared';
import { z } from 'zod';
import { demoTenants, upsertTenant, upsertUser } from '../seed/seed.js';

// Seeds the demo tenants and users. Idempotent: safe to run on every `make dev`.
// In production the password must be given explicitly (public demo only).

const env = parseEnv(
  z
    .object({
      NODE_ENV: nodeEnvSchema.default('development'),
      DATABASE_MIGRATOR_URL: postgresUrlSchema,
      SEED_PASSWORD: z.string().min(12).optional(),
    })
    .refine((e) => e.NODE_ENV !== 'production' || e.SEED_PASSWORD !== undefined, {
      message: 'SEED_PASSWORD is required in production',
      path: ['SEED_PASSWORD'],
    }),
  process.env,
);

const password = env.SEED_PASSWORD ?? DEMO_DEFAULT_PASSWORD;
const { db, close } = createDb(env.DATABASE_MIGRATOR_URL, { max: 1 });
try {
  await upsertUser(db, { ...DEMO_PLATFORM_ADMIN, password, platformRole: 'admin' });
  for (const tenant of demoTenants(password)) {
    await upsertTenant(db, tenant);
  }
  console.log('seed: demo tenants and users ready');
} finally {
  await close();
}
