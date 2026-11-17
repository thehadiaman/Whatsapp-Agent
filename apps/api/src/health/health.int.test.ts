import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, testConfig } from '../test/harness.js';
import type { ApiConfig } from '../config.js';

async function start(config: ApiConfig): Promise<{ app: INestApplication; url: string }> {
  const { app, url } = await startApi(config);
  return { app, url };
}

describe('health and readiness against real Postgres and Redis', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    ({ app, url } = await start(testConfig()));
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers 200 without touching dependencies', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready answers 200 when Postgres and Redis respond', async () => {
    const response = await fetch(`${url}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });
});

describe('readiness with Redis unreachable', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    // Port 1 on loopback is never a Redis server: connection is refused.
    ({ app, url } = await start(testConfig({ REDIS_URL: 'redis://127.0.0.1:1/0' })));
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ready answers 503 and names the failing dependency', async () => {
    const response = await fetch(`${url}/ready`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('not_ready');
    expect(body.checks['postgres']).toBe('ok');
    expect(['failed', 'timed_out']).toContain(body.checks['redis']);
  });

  it('GET /health still answers 200', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
  });
});
