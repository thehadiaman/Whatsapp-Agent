import type { Logger } from '@app/shared';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import type { Auth } from './auth/auth.js';
import { requestContextMiddleware } from './common/request-context.js';
import type { ApiConfig } from './config.js';
import { AUTH } from './infra/tokens.js';
import { NestLogger } from './logging/nest-logger.js';

/** Builds the Nest application. Shared by main.ts and integration tests. */
export async function createApp(
  config: ApiConfig,
  logger: Logger,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger), {
    logger: new NestLogger(logger),
    // Body parsing is added below, after the auth handler, which reads the raw stream itself.
    bodyParser: false,
  });

  // Order matters: headers, request ID, then auth, then JSON parsing for everything else.
  app.use(helmet());
  app.use(requestContextMiddleware(logger));

  const authHandler = toNodeHandler(app.get<Auth>(AUTH));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/auth/')) {
      void authHandler(req, res);
      return;
    }
    next();
  });

  app.useBodyParser('json', { limit: '100kb' });
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableShutdownHooks();
  return app;
}
