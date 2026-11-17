import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL, REDIS } from '../infra/tokens.js';
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
      inject: [PG_POOL, REDIS],
      useFactory: (pool: pg.Pool, redis: Redis): ReadinessProbe[] => [
        {
          name: 'postgres',
          check: async () => {
            await pool.query('select 1');
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
