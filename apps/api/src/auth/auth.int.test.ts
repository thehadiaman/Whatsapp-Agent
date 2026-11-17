import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrangeDb,
  call,
  clientIp,
  createTestTenant,
  ORIGIN,
  PASSWORD,
  signIn,
  startApi,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';
import { SIGN_IN_LIMIT } from './auth.js';

let api: RunningApi;
let tenant: TestTenant;

beforeAll(async () => {
  const db = arrangeDb();
  try {
    tenant = await createTestTenant(db, 'auth');
  } finally {
    await db.close();
  }
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

async function attemptSignIn(email: string, password: string, ip: string) {
  return call(api, '/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password },
    ip,
  });
}

describe('sign-in', () => {
  it('sets an httpOnly, SameSite=Lax session cookie', async () => {
    const response = await fetch(`${api.url}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': clientIp() },
      body: JSON.stringify({ email: tenant.ownerEmail, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects a wrong password without saying which part was wrong', async () => {
    const { status, json } = await attemptSignIn(
      tenant.ownerEmail,
      'wrong-password-123',
      clientIp(),
    );
    expect(status).toBe(401);
    expect(JSON.stringify(json).toLowerCase()).toContain('invalid email or password');
  });

  it('stores passwords hashed, never in plain text', async () => {
    const db = arrangeDb();
    try {
      const result = await db.pool.query<{ password: string }>(
        `select a.password from accounts a join users u on u.id = a.user_id where u.email = $1`,
        [tenant.ownerEmail],
      );
      expect(result.rows[0]?.password).not.toContain(PASSWORD);
      expect(result.rows[0]?.password.length).toBeGreaterThan(40);
    } finally {
      await db.close();
    }
  });

  it(`limits sign-in to ${String(SIGN_IN_LIMIT.max)} attempts per minute per client`, async () => {
    const ip = clientIp();
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_LIMIT.max + 1; i++) {
      statuses.push((await attemptSignIn(tenant.agentEmail, 'wrong-password-123', ip)).status);
    }
    expect(statuses.slice(0, SIGN_IN_LIMIT.max).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // Another client is not affected.
    expect((await attemptSignIn(tenant.agentEmail, PASSWORD, clientIp())).status).toBe(200);
  });

  it('has no public sign-up', async () => {
    const { status } = await call(api, '/api/auth/sign-up/email', {
      method: 'POST',
      body: { email: 'new@test.example', password: 'a-long-password-1', name: 'New' },
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('sign-out ends the session', async () => {
    const cookie = await signIn(api, tenant.agentEmail);
    expect((await call(api, '/api/me', { cookie })).status).toBe(200);
    const out = await call(api, '/api/auth/sign-out', { method: 'POST', cookie, body: {} });
    expect(out.status).toBe(200);
    expect((await call(api, '/api/me', { cookie })).status).toBe(401);
  });
});

describe('every response', () => {
  it('carries secure headers and a request ID', async () => {
    const { headers } = await call(api, '/health');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
