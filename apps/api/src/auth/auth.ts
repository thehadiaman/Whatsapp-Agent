import { schema, type Database } from '@app/db';
import type { Logger } from '@app/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { trustedOrigin, type ApiConfig } from '../config.js';

export const SIGN_IN_LIMIT = { window: 60, max: 5 } as const;

/**
 * Email and password sign-in with httpOnly session cookies (Better Auth).
 * - No self sign-up: the platform admin creates tenants and their first users.
 * - Passwords are hashed with scrypt, Better Auth's default.
 * - Sign-in is limited to 5 attempts per minute per client IP. The IP comes
 *   from `x-real-ip`, which the reverse proxy overwrites; clients cannot set it.
 * - Cookies are SameSite=Lax and httpOnly, Secure in production.
 */
export function createAuth(config: ApiConfig, db: Database, logger: Logger) {
  return betterAuth({
    appName: 'Support desk',
    baseURL: config.PUBLIC_APP_URL,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [trustedOrigin(config)],
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        platformRole: { type: 'string', required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': SIGN_IN_LIMIT },
    },
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: 'desk',
      useSecureCookies: config.NODE_ENV === 'production',
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log: (level, message) => {
        logger[level]({ component: 'better-auth' }, message);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
