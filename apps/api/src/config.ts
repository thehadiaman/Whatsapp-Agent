import {
  baseEnvSchema,
  parseEnv,
  portSchema,
  postgresUrlSchema,
  redisUrlSchema,
} from '@app/shared';
import { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: portSchema.default(4000),
  /** app_user: cannot bypass row-level security. */
  DATABASE_URL: postgresUrlSchema,
  /** app_platform: platform-admin read functions only. */
  DATABASE_PLATFORM_URL: postgresUrlSchema,
  REDIS_URL: redisUrlSchema,
  /** Public origin of the web app. Session cookies and the CSRF origin check are bound to it. */
  PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }),
  /** Signs session cookies. At least 32 characters; generate with `openssl rand -base64 32`. */
  BETTER_AUTH_SECRET: z.string().min(32),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const API_CONFIG = Symbol('API_CONFIG');

export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}

export function trustedOrigin(config: ApiConfig): string {
  return new URL(config.PUBLIC_APP_URL).origin;
}
