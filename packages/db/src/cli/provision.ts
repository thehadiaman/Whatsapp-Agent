import { parseEnv, postgresUrlSchema } from '@app/shared';
import { z } from 'zod';
import { bootstrapRoles, migrate } from '../setup.js';

// Usage: node dist/cli/provision.js [bootstrap] [migrate]
// With no arguments, runs both. Bootstrap needs DATABASE_SUPERUSER_URL.

const steps = process.argv.slice(2);
const run = (step: string) => steps.length === 0 || steps.includes(step);

if (run('bootstrap')) {
  const env = parseEnv(
    z.object({
      DATABASE_SUPERUSER_URL: postgresUrlSchema,
      DATABASE_MIGRATOR_URL: postgresUrlSchema,
      DATABASE_URL: postgresUrlSchema,
      DATABASE_PLATFORM_URL: postgresUrlSchema,
    }),
    process.env,
  );
  await bootstrapRoles({
    superuser: env.DATABASE_SUPERUSER_URL,
    migrator: env.DATABASE_MIGRATOR_URL,
    user: env.DATABASE_URL,
    platform: env.DATABASE_PLATFORM_URL,
  });
  console.log('db: roles ready');
}

if (run('migrate')) {
  const env = parseEnv(z.object({ DATABASE_MIGRATOR_URL: postgresUrlSchema }), process.env);
  await migrate(env.DATABASE_MIGRATOR_URL);
  console.log('db: migrations applied');
}
