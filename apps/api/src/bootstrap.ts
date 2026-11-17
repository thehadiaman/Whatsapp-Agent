import type { Logger } from '@app/shared';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { ApiConfig } from './config.js';
import { NestLogger } from './logging/nest-logger.js';

/** Builds the Nest application. Shared by main.ts and integration tests. */
export async function createApp(config: ApiConfig, logger: Logger): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, logger), {
    logger: new NestLogger(logger),
  });
  app.enableShutdownHooks();
  return app;
}
