import type { Logger } from '@app/shared';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { LOGGER, PG_POOL, REDIS } from './tokens.js';

/**
 * Owns the process-wide Postgres pool and Redis client and closes them on
 * shutdown. Phase 1 adds the query layer and per-transaction tenant context
 * on top of this pool.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: Logger): pg.Pool => {
        const pool = new pg.Pool({
          connectionString: config.DATABASE_URL,
          max: 10,
          connectionTimeoutMillis: 2_000,
        });
        // An idle client erroring (e.g. Postgres restarted) must not crash the process.
        pool.on('error', (error) => {
          logger.warn({ err: error }, 'postgres idle client error');
        });
        return pool;
      },
    },
    {
      provide: REDIS,
      inject: [API_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: Logger): Redis => {
        const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
        redis.on('error', (error) => {
          logger.warn({ err: error }, 'redis connection error');
        });
        return redis;
      },
    },
  ],
  exports: [PG_POOL, REDIS],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end();
  }
}
