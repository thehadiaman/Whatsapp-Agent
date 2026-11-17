import { z } from 'zod';

/**
 * `mock` runs every external system against local fakes and the simulator.
 * `live` talks to AWS and Meta. Mock is the default so that a missing variable
 * can never cause a paid or outbound call.
 */
export const appModeSchema = z.enum(['mock', 'live']);
export type AppMode = z.infer<typeof appModeSchema>;

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export const portSchema = z.coerce.number().int().min(1).max(65_535);
export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
export const redisUrlSchema = z.url({ protocol: /^rediss?$/ });

/** Variables every service reads. Services extend this with their own. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  APP_MODE: appModeSchema.default('mock'),
  LOG_LEVEL: logLevelSchema.default('info'),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parses environment variables against a schema. On failure, throws an error
 * that names each bad variable and the rule it broke, but never echoes values,
 * because values are often secrets.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Readonly<Record<string, string | undefined>>,
): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${name}: ${describeIssue(issue)}`;
  });
  throw new EnvValidationError(issues);
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${issue.expected}`;
    case 'invalid_value':
      return `must be one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
    case 'invalid_format':
      return `must be a valid ${issue.format}`;
    case 'too_small':
      return `must be at least ${String(issue.minimum)}`;
    case 'too_big':
      return `must be at most ${String(issue.maximum)}`;
    default:
      return 'is invalid';
  }
}
