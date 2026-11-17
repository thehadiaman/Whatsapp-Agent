import {
  baseEnvSchema,
  parseEnv,
  portSchema,
  postgresUrlSchema,
  redisUrlSchema,
} from '@app/shared';
import type { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: portSchema.default(4000),
  DATABASE_URL: postgresUrlSchema,
  REDIS_URL: redisUrlSchema,
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const API_CONFIG = Symbol('API_CONFIG');

export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}
