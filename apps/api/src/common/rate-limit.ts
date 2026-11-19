import { HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../infra/tokens.js';

/** A tighter per-user limit for one route, on top of the general one. */
export interface RouteLimit {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_KEY = 'route-rate-limit';
export const RateLimit = (limit: RouteLimit) => SetMetadata(RATE_LIMIT_KEY, limit);

/** Every signed-in user, across all routes. Generous: the inbox refetches on every change. */
export const GENERAL_LIMIT: RouteLimit = { name: 'all', limit: 600, windowSeconds: 60 };

/**
 * Fixed-window counters in Redis, keyed by user, so the limit holds across
 * API instances and restarts. One INCR per check; the key expires with its window.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Throws 429 over the limit, and sets `Retry-After` on `response` when given. */
  async consume(
    userId: string,
    limit: RouteLimit,
    response?: { setHeader(name: string, value: string): unknown },
  ): Promise<void> {
    const window = Math.floor(Date.now() / 1000 / limit.windowSeconds);
    const key = `ratelimit:${limit.name}:${userId}:${String(window)}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, limit.windowSeconds + 1);
    if (count > limit.limit) {
      const retryAfter =
        limit.windowSeconds - (Math.floor(Date.now() / 1000) % limit.windowSeconds);
      response?.setHeader('retry-after', String(retryAfter));
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Too many requests. Wait ${String(retryAfter)} seconds and try again.`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
