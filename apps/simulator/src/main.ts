import { baseEnvSchema, createLogger, parseEnv, portSchema } from '@app/shared';
import { createSimulatorServer } from './server.js';

const config = parseEnv(
  baseEnvSchema.extend({ SIMULATOR_PORT: portSchema.default(4010) }),
  process.env,
);
const logger = createLogger({ service: 'simulator', level: config.LOG_LEVEL });

const server = createSimulatorServer();
server.listen(config.SIMULATOR_PORT, () => {
  logger.info({ port: config.SIMULATOR_PORT }, 'simulator listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'simulator shutting down');
  server.close();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
