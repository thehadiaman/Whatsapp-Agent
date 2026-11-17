import type { DbHandle } from '@app/db';
import type { Logger } from '@app/shared';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './auth/access.guard.js';
import { createAuth } from './auth/auth.js';
import { API_CONFIG, type ApiConfig } from './config.js';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { AUTH, DB, LOGGER } from './infra/tokens.js';
import { TenancyModule } from './tenancy/tenancy.module.js';

@Module({})
export class AppModule {
  /** Config and logger are built once in main.ts (or a test) and injected everywhere. */
  static forRoot(config: ApiConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [InfraModule, HealthModule, TenancyModule],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        {
          provide: AUTH,
          inject: [DB],
          useFactory: (db: DbHandle) => createAuth(config, db.db, logger),
        },
        { provide: APP_GUARD, useClass: AccessGuard },
      ],
      exports: [API_CONFIG, LOGGER, AUTH],
    };
  }
}
