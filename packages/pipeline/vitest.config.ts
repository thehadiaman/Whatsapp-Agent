import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // CI sets the environment directly.
}

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.int.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          // One worker fleet at a time, as in production: each harness runs a
          // sweeper that (correctly) sees every tenant's stuck replies, so
          // parallel files would pick up each other's messages.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
