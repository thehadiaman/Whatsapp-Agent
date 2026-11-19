import { createDb } from '@app/db';
import {
  createQueues,
  LocalDiskStorage,
  pipelineEnvSchema,
  pipelineSettings,
  ProviderRegistry,
  RedisEventPublisher,
  startWorkers,
} from '@app/pipeline';
import {
  baseEnvSchema,
  createLogger,
  parseEnv,
  postgresUrlSchema,
  redisUrlSchema,
} from '@app/shared';
import { Redis } from 'ioredis';

const config = parseEnv(
  baseEnvSchema
    .extend(pipelineEnvSchema.shape)
    .extend({ DATABASE_URL: postgresUrlSchema, REDIS_URL: redisUrlSchema }),
  process.env,
);
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });

// BullMQ workers block on Redis; their connection must not limit retries per request.
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (error) => {
  logger.warn({ err: error }, 'redis connection error');
});

const database = createDb(config.DATABASE_URL, { max: 10 });
database.pool.on('error', (error) => {
  logger.warn({ err: error }, 'postgres idle client error');
});
// Publishing on its own connection keeps it independent of BullMQ's.
const publisher = new Redis(config.REDIS_URL);
const settings = pipelineSettings(config);
const queues = createQueues(connection, settings, config.QUEUE_PREFIX);
const workers = startWorkers(
  {
    db: database.db,
    queues,
    providers: ProviderRegistry.fromEnv(config),
    storage: new LocalDiskStorage(config.MEDIA_STORAGE_DIR),
    logger,
    settings,
    events: new RedisEventPublisher(publisher, logger),
  },
  { connection, prefix: config.QUEUE_PREFIX },
);
logger.info({ mode: config.APP_MODE }, 'worker ready');

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down');
  // Finish the jobs in hand, then release connections.
  await workers.close();
  await queues.close();
  await database.close();
  connection.disconnect();
  publisher.disconnect();
}
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
