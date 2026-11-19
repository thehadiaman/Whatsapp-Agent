import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './env.js';

export type { Logger } from 'pino';

export interface LoggerOptions {
  /** Service name stamped on every line, e.g. `api` or `worker`. */
  service: string;
  level: LogLevel;
  /** Defaults to stdout. Tests pass a stream to capture output. */
  destination?: DestinationStream;
}

/**
 * Fields that must never reach a log line in clear (brief §4: mask phone
 * numbers and message text). Matched at the top level and one level down.
 */
const MASKED_FIELDS = [
  'text',
  'body',
  'caption',
  'phone',
  'waId',
  'wa_id',
  'bsuid',
  'from',
  'to',
  'recipient',
  'password',
  'accessToken',
  'authorization',
  'cookie',
];
export const LOG_REDACT_PATHS = MASKED_FIELDS.flatMap((field) => [field, `*.${field}`]);

/** Structured JSON logger shared by every service. */
export function createLogger({ service, level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      redact: { paths: LOG_REDACT_PATHS, censor: '[masked]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    destination ?? pino.destination({ sync: false }),
  );
}
