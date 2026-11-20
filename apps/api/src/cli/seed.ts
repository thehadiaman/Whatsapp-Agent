import { createDb } from '@app/db';
import { embedderFor, pipelineEnvSchema, storageFor } from '@app/pipeline';
import {
  DEMO_DEFAULT_PASSWORD,
  DEMO_PLATFORM_ADMIN,
  nodeEnvSchema,
  parseEnv,
  postgresUrlSchema,
} from '@app/shared';
import { z } from 'zod';
import { seedConversations } from '../seed/conversations.js';
import { seedHistory } from '../seed/history.js';
import { seedKnowledge } from '../seed/knowledge.js';
import { demoTenants, upsertTenant, upsertUser } from '../seed/seed.js';

// Seeds the demo tenants and users. Idempotent: safe to run on every `make dev`.
// In production the password must be given explicitly (public demo only).

const env = parseEnv(
  z
    .object({
      NODE_ENV: nodeEnvSchema.default('development'),
      DATABASE_MIGRATOR_URL: postgresUrlSchema,
      SEED_PASSWORD: z.string().min(12).optional(),
      /** Extra generated conversations for Qamar, to see the long-list state. */
      SEED_BULK_CONVERSATIONS: z.coerce.number().int().min(0).max(2000).default(0),
    })
    // Storage and embedder as the API and worker build them: local disk and the
    // mock offline; S3 and Cohere in live mode, so seeded knowledge is searchable.
    .extend(pipelineEnvSchema.shape)
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
  const storage = storageFor(env);
  // History first, so on a new database older conversations get lower numbers.
  await seedHistory(db);
  await seedConversations(db, storage, { bulk: env.SEED_BULK_CONVERSATIONS });
  await seedKnowledge(db, storage, { embedder: embedderFor(env) });
  console.log('seed: demo tenants, users, conversations, history, knowledge and orders ready');
} finally {
  await close();
}
