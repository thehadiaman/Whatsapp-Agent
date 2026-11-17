import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDb, type DbHandle } from '@app/db';
import { testDatabaseUrls } from '@app/db/testing';
import { createLogger } from '@app/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../bootstrap.js';
import { apiEnvSchema, type ApiConfig } from '../config.js';
import { upsertTenant, upsertUser, type SeedTenant } from '../seed/seed.js';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery';

const quietLogger = createLogger({
  service: 'api-test',
  level: 'error',
  destination: new Writable({
    write: (_chunk, _encoding, done) => {
      done();
    },
  }),
});

export function testConfig(overrides: Partial<Record<keyof ApiConfig, string>> = {}): ApiConfig {
  const urls = testDatabaseUrls();
  return apiEnvSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: urls.user,
    DATABASE_PLATFORM_URL: urls.platform,
    REDIS_URL: process.env['TEST_REDIS_URL'],
    PUBLIC_APP_URL: ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0000',
    ...overrides,
  });
}

export interface RunningApi {
  app: NestExpressApplication;
  url: string;
  close(): Promise<void>;
}

export async function startApi(config: ApiConfig = testConfig()): Promise<RunningApi> {
  const app = await createApp(config, quietLogger);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl(), close: () => app.close() };
}

/** A migrator connection for arranging test data (bypasses RLS, like the seed). */
export function arrangeDb(): DbHandle {
  return createDb(testDatabaseUrls().migrator, { max: 2 });
}

export interface TestTenant {
  id: string;
  ownerEmail: string;
  agentEmail: string;
}

/** A tenant with one owner and one agent, unique to this test run. */
export async function createTestTenant(db: DbHandle, label: string): Promise<TestTenant> {
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${label}-${suffix}@test.example`;
  const agentEmail = `agent-${label}-${suffix}@test.example`;
  const tenant: SeedTenant = {
    slug: `${label}-${suffix}`,
    name: `Tenant ${label.toUpperCase()}`,
    timezone: 'Asia/Dubai',
    members: [
      { name: `Owner ${label}`, email: ownerEmail, role: 'owner', password: PASSWORD },
      { name: `Agent ${label}`, email: agentEmail, role: 'agent', password: PASSWORD },
    ],
  };
  const id = await upsertTenant(db.db, tenant);
  return { id, ownerEmail, agentEmail };
}

export async function createPlatformAdmin(db: DbHandle): Promise<string> {
  const email = `admin-${randomUUID().slice(0, 8)}@test.example`;
  await upsertUser(db.db, { name: 'Admin', email, password: PASSWORD, platformRole: 'admin' });
  return email;
}

/** Each caller gets its own client IP so rate-limit buckets never collide between tests. */
export function clientIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `10.${n()}.${n()}.${n()}`;
}

export interface CallOptions {
  method?: string;
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  ip?: string;
}

export interface CallResult {
  status: number;
  json: unknown;
  headers: globalThis.Headers;
}

export async function call(
  api: RunningApi,
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { 'x-real-ip': options.ip ?? clientIp() };
  if (options.cookie) headers['cookie'] = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
  const response = await fetch(`${api.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, json, headers: response.headers };
}

/** Signs in through the real Better Auth endpoint and returns the session cookie. */
export async function signIn(api: RunningApi, email: string, password = PASSWORD): Promise<string> {
  const response = await fetch(`${api.url}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': clientIp() },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) {
    throw new Error(`sign-in failed for ${email}: ${String(response.status)}`);
  }
  const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0]);
  return cookies.join('; ');
}
