import { createLogger } from '@app/shared';
import { createApp } from './bootstrap.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig(process.env);
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });

const app = await createApp(config, logger);
await app.listen(config.API_PORT);
logger.info({ port: config.API_PORT, mode: config.APP_MODE }, 'api listening');
