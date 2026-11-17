import type { Logger } from '@app/shared';
import { Module, type DynamicModule } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from './config.js';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { LOGGER } from './infra/tokens.js';

@Module({})
export class AppModule {
  /** Config and logger are built once in main.ts (or a test) and injected everywhere. */
  static forRoot(config: ApiConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [InfraModule, HealthModule],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [API_CONFIG, LOGGER],
    };
  }
}
