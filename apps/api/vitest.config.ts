import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests read TEST_DATABASE_URL and TEST_REDIS_URL. CI sets them
// directly; locally they come from the repo's .env when it exists.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  // SWC emits the decorator metadata NestJS dependency injection relies on;
  // Vite's default transform (esbuild/oxc) does not.
  plugins: [swc.vite()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['./src/test/global-setup.ts'],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
