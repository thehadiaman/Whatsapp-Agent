import { baseEnvSchema, createLogger, parseEnv, portSchema } from '@app/shared';
import { z } from 'zod';
import { createSimulator } from './simulator.js';

const config = parseEnv(
  baseEnvSchema.extend({
    SIMULATOR_PORT: portSchema.default(4010),
    SIMULATOR_HOST: z.string().default('127.0.0.1'),
    SIMULATOR_PUBLIC_URL: z.url().default('http://localhost:4010'),
    SIMULATOR_WEBHOOK_URL: z.url(),
    SIMULATOR_APP_SECRET: z.string().min(8),
    SIMULATOR_ACCESS_TOKEN: z.string().min(8),
    SIMULATOR_VERIFY_TOKEN: z.string().min(8),
  }),
  process.env,
);
const logger = createLogger({ service: 'simulator', level: config.LOG_LEVEL });

const simulator = createSimulator({
  webhookUrl: config.SIMULATOR_WEBHOOK_URL,
  appSecret: config.SIMULATOR_APP_SECRET,
  accessToken: config.SIMULATOR_ACCESS_TOKEN,
  publicUrl: config.SIMULATOR_PUBLIC_URL,
  onError: (error) => {
    logger.warn({ err: error }, 'webhook delivery gave up');
  },
});
const server = await simulator.listen(config.SIMULATOR_PORT, config.SIMULATOR_HOST);
logger.info({ url: server.url }, 'simulator listening');

// Meta verifies a webhook when it is configured; the simulator does the same
// once the API is reachable, and logs the result.
void (async () => {
  for (let attempt = 1; attempt <= 30; attempt++) {
    if (await simulator.verifyWebhook(config.SIMULATOR_VERIFY_TOKEN)) {
      logger.info('webhook verification handshake passed');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  logger.warn(
    'webhook verification handshake failed; is the API running with the same verify token?',
  );
})();

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'simulator shutting down');
  void server.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
