import { prepareTestDatabase } from '@app/db/testing';
import { Redis } from 'ioredis';

// Fresh test database and an empty Redis test index, once per run.
export default async function setup(): Promise<void> {
  await prepareTestDatabase();
  const url = process.env['TEST_REDIS_URL'];
  if (!url) throw new Error('TEST_REDIS_URL is not set. Copy .env.example to .env (make setup).');
  const redis = new Redis(url);
  await redis.flushdb();
  redis.disconnect();
}
