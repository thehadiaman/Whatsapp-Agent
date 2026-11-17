import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env file: rely on the process environment (CI).
}

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 15_000,
  },
});
