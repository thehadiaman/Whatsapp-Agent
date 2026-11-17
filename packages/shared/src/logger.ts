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
 * Structured JSON logger shared by every service.
 * Field-level masking of phone numbers and message text is added with the
 * WhatsApp pipeline (phase 2), where those fields first appear.
 */
export function createLogger({ service, level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    destination ?? pino.destination({ sync: false }),
  );
}
