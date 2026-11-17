import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @app/db generate` diffs src/schema.ts against the last
// snapshot and writes a new SQL migration. It never connects to a database.
// Row-level security, grants and functions live in hand-written migrations
// (`drizzle-kit generate --custom`), so they can be reviewed as plain SQL.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case',
});
