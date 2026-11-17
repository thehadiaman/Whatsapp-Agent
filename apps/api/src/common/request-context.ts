import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Logger } from '@app/shared';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
  logger: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The current request's context, or undefined outside a request (e.g. startup). */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;
const QUIET_PATHS = new Set(['/health', '/ready']);

/**
 * Gives every request an ID (reusing a well-formed `x-request-id` from the
 * proxy), echoes it in the response, binds a child logger to it for the rest
 * of the request, and writes one access-log line when the response finishes.
 * Paths are logged without query strings; bodies are never logged.
 */
export function requestContextMiddleware(root: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    const logger = root.child({ requestId });
    const started = performance.now();

    res.on('finish', () => {
      const line = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      };
      if (QUIET_PATHS.has(req.path)) logger.debug(line, 'request');
      else logger.info(line, 'request');
    });

    storage.run({ requestId, logger }, next);
  };
}
