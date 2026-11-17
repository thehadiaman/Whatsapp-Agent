import { bootstrapRoles, migrate, recreateDatabase, withDatabase } from './setup.js';

export const TEST_DATABASE = 'app_test';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env (make setup).`);
  }
  return value;
}

/** Connection URLs for the test database, derived from the dev URLs. */
export function testDatabaseUrls() {
  return {
    superuser: withDatabase(required('DATABASE_SUPERUSER_URL'), TEST_DATABASE),
    migrator: withDatabase(required('DATABASE_MIGRATOR_URL'), TEST_DATABASE),
    user: withDatabase(required('DATABASE_URL'), TEST_DATABASE),
    platform: withDatabase(required('DATABASE_PLATFORM_URL'), TEST_DATABASE),
  };
}

/** Fresh database, roles and migrations. Run once per test run (global setup). */
export async function prepareTestDatabase(): Promise<void> {
  const urls = testDatabaseUrls();
  await recreateDatabase(withDatabase(urls.superuser, 'postgres'), TEST_DATABASE);
  await bootstrapRoles(urls);
  await migrate(urls.migrator);
}
