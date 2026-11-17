import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  baseEnvSchema,
  EnvValidationError,
  parseEnv,
  portSchema,
  postgresUrlSchema,
  redisUrlSchema,
} from './env.js';

const serviceSchema = baseEnvSchema.extend({
  PORT: portSchema,
  DATABASE_URL: postgresUrlSchema,
  REDIS_URL: redisUrlSchema,
});

const valid = {
  PORT: '4000',
  DATABASE_URL: 'postgres://app:secret@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('parseEnv', () => {
  it('applies safe defaults: mock mode, development, info logs', () => {
    const env = parseEnv(serviceSchema, valid);
    expect(env.APP_MODE).toBe('mock');
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces ports to numbers', () => {
    expect(parseEnv(serviceSchema, valid).PORT).toBe(4000);
  });

  it('accepts live mode only when set explicitly', () => {
    expect(parseEnv(serviceSchema, { ...valid, APP_MODE: 'live' }).APP_MODE).toBe('live');
  });

  it('lists every invalid variable in one error', () => {
    const attempt = () =>
      parseEnv(serviceSchema, {
        APP_MODE: 'staging',
        PORT: '70000',
        DATABASE_URL: 'mysql://localhost/app',
      });
    expect(attempt).toThrow(EnvValidationError);
    try {
      attempt();
    } catch (error) {
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('APP_MODE: must be one of "mock", "live"');
      expect(issues).toContain('PORT: must be at most 65535');
      expect(issues).toContain('DATABASE_URL: must be a valid url');
      expect(issues).toContain('REDIS_URL: expected string');
    }
  });

  it('never echoes variable values, which may be secrets', () => {
    const secret = 'hunter2-should-not-leak';
    try {
      parseEnv(serviceSchema, { ...valid, DATABASE_URL: `not a url ${secret}`, APP_MODE: secret });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('works with any zod schema', () => {
    expect(parseEnv(z.object({ FLAG: z.literal('1') }), { FLAG: '1' })).toEqual({ FLAG: '1' });
  });
});
