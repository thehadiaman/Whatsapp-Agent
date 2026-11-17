import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DbHandle } from '@app/db';
import { DB, REDIS } from '../infra/tokens.js';
import { HealthController } from './health.controller.js';
import {
  READINESS_PROBES,
  READINESS_TIMEOUT_MS,
  ReadinessService,
  type ReadinessProbe,
} from './readiness.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    ReadinessService,
    { provide: READINESS_TIMEOUT_MS, useValue: 1_000 },
    {
      provide: READINESS_PROBES,
      inject: [DB, REDIS],
      useFactory: (db: DbHandle, redis: Redis): ReadinessProbe[] => [
        {
          name: 'postgres',
          check: async () => {
            await db.pool.query('select 1');
          },
        },
        {
          name: 'redis',
          check: async () => {
            await redis.ping();
          },
        },
      ],
    },
  ],
})
export class HealthModule {}
