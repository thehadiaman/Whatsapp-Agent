import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real web app and the real API against the seeded
// database (`make db`). Run them with `make e2e`. Locally, servers already
// running from `make dev` are reused.
const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  workers: 1,
  retries: ci ? 1 : 0,
  reporter: ci ? 'github' : 'list',
  use: {
    // Must match PUBLIC_APP_URL: the API's CSRF check compares Origin exactly.
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://127.0.0.1:4000/ready',
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      // The same standalone server the Docker image runs. Run through sh with
      // `exec` (not pnpm) so Playwright's shutdown signal reaches the server.
      command:
        "sh -c 'cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/ && HOSTNAME=localhost PORT=3000 exec node .next/standalone/apps/web/server.js'",
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
  ],
});
