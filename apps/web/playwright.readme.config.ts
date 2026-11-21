import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The README's screenshots, taken by scripts/readme-screenshots.sh against a
// freshly seeded database so they show the demo, not leftovers from test runs.
// Servers always start fresh here: reusing a dev server would use its database.
const webServers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testDir: './readme-shots',
  retries: 0,
  reporter: 'list',
  webServer: webServers.map((server) => ({ ...server, reuseExistingServer: false })),
});
