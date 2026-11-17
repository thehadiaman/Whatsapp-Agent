import { Writable } from 'node:stream';
import { createLogger } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { ReadinessService, type ReadinessProbe } from './readiness.service.js';

function silentLogger() {
  const messages: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      messages.push(chunk.toString());
      done();
    },
  });
  return { logger: createLogger({ service: 'test', level: 'debug', destination }), messages };
}

const ok = (name: string): ReadinessProbe => ({ name, check: () => Promise.resolve() });
const failing = (name: string, message: string): ReadinessProbe => ({
  name,
  check: () => Promise.reject(new Error(message)),
});
const hanging = (name: string): ReadinessProbe => ({
  name,
  check: () =>
    new Promise<void>(() => {
      // never settles
    }),
});

describe('ReadinessService', () => {
  it('is ready when every probe passes', async () => {
    const { logger } = silentLogger();
    const service = new ReadinessService([ok('postgres'), ok('redis')], 100, logger);

    await expect(service.check()).resolves.toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('is not ready when a probe fails, and keeps the error out of the report', async () => {
    const { logger, messages } = silentLogger();
    const secret = 'password authentication failed for user "app" at 10.0.0.5';
    const service = new ReadinessService([ok('postgres'), failing('redis', secret)], 100, logger);

    const report = await service.check();

    expect(report).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'failed' } });
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
    expect(messages.join('')).toContain('readiness probe failed');
  });

  it('times out a probe that never answers', async () => {
    const { logger } = silentLogger();
    const service = new ReadinessService([hanging('postgres'), ok('redis')], 20, logger);

    const started = Date.now();
    const report = await service.check();

    expect(report.checks).toEqual({ postgres: 'timed_out', redis: 'ok' });
    expect(report.status).toBe('not_ready');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
