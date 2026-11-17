import { baseEnvSchema, createLogger, parseEnv, redisUrlSchema } from '@app/shared';
import { Redis } from 'ioredis';

// Phase 0 skeleton: proves the worker starts, reaches Redis and shuts down
// cleanly. Queues and job processors arrive with the WhatsApp pipeline (phase 2).

const config = parseEnv(baseEnvSchema.extend({ REDIS_URL: redisUrlSchema }), process.env);
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });

const redis = new Redis(config.REDIS_URL);
redis.on('error', (error) => {
  logger.warn({ err: error }, 'redis connection error');
});

await redis.ping();
logger.info({ mode: config.APP_MODE }, 'worker ready');

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'worker shutting down');
  redis.disconnect();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
