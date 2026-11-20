import { createDb, type DbHandle } from '@app/db';
import {
  assistantDeps,
  createQueues,
  LocalDiskStorage,
  pipelineSettings,
  ProviderRegistry,
  RedisEventPublisher,
  type AssistantDeps,
  type EventPublisher,
  type ObjectStorage,
  type Queues,
} from '@app/pipeline';
import type { Logger } from '@app/shared';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  ASSISTANT,
  DB,
  EVENTS,
  LOGGER,
  PLATFORM_DB,
  PROVIDERS,
  QUEUES,
  REDIS,
  STORAGE,
} from './tokens.js';

function watchPool(handle: DbHandle, logger: Logger, name: string): DbHandle {
  // An idle client erroring (e.g. Postgres restarted) must not crash the process.
  handle.pool.on('error', (error) => {
    logger.warn({ err: error, pool: name }, 'postgres idle client error');
  });
  return handle;
}

/**
 * Owns the process-wide database pools and Redis client and closes them on
 * shutdown. Two pools, two roles: `DB` (app_user, row-level security applies)
 * for everything, `PLATFORM_DB` (app_platform) for platform-admin reads only.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [API_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: Logger): DbHandle =>
        watchPool(createDb(config.DATABASE_URL, { max: 10 }), logger, 'app'),
    },
    {
      provide: PLATFORM_DB,
      inject: [API_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: Logger): DbHandle =>
        watchPool(createDb(config.DATABASE_PLATFORM_URL, { max: 2 }), logger, 'platform'),
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
    {
      provide: QUEUES,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): Queues =>
        // BullMQ needs its own connection: no per-request retry limit.
        createQueues(
          new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
          pipelineSettings(config),
          config.QUEUE_PREFIX,
        ),
    },
    {
      provide: PROVIDERS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ProviderRegistry.fromEnv(config),
    },
    {
      provide: EVENTS,
      inject: [REDIS, LOGGER],
      useFactory: (redis: Redis, logger: Logger): EventPublisher =>
        new RedisEventPublisher(redis, logger),
    },
    {
      provide: STORAGE,
      inject: [API_CONFIG],
      // Mock mode: local disk, shared with the worker. Live mode: S3 (phase 7).
      useFactory: (config: ApiConfig): ObjectStorage =>
        new LocalDiskStorage(config.MEDIA_STORAGE_DIR),
    },
    {
      provide: ASSISTANT,
      inject: [API_CONFIG],
      // The API embeds questions for "Try a question"; the worker runs the turns.
      useFactory: (config: ApiConfig): AssistantDeps => assistantDeps(config),
    },
  ],
  exports: [DB, PLATFORM_DB, REDIS, QUEUES, PROVIDERS, EVENTS, STORAGE, ASSISTANT],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(PLATFORM_DB) private readonly platformDb: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUES) private readonly queues: Queues,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.queues.close();
    await Promise.all([this.db.close(), this.platformDb.close()]);
  }
}
