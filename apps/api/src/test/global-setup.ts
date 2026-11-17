import { prepareTestDatabase } from '@app/db/testing';

// Integration tests: fresh test database, roles and migrations once per run.
export default async function setup(): Promise<void> {
  try {
    process.loadEnvFile(new URL('../../../../.env', import.meta.url));
  } catch {
    // CI sets the environment directly.
  }
  await prepareTestDatabase();
}
