import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Database roles. Names are fixed because migrations grant to them by name.
 * - app_migrator: owns the schema, runs migrations and seeds. BYPASSRLS.
 * - app_user:     what the API and worker connect as. Cannot bypass RLS and owns nothing.
 * - app_platform: platform-admin reads, only through SECURITY DEFINER functions.
 */
export const ROLES = {
  migrator: 'app_migrator',
  user: 'app_user',
  platform: 'app_platform',
} as const;

export interface DatabaseUrls {
  /** Superuser connection, used only to create roles and set database ownership. */
  superuser: string;
  migrator: string;
  user: string;
  platform: string;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

function credentials(url: string, expectedRole: string): { password: string; database: string } {
  const parsed = new URL(url);
  const role = decodeURIComponent(parsed.username);
  if (role !== expectedRole) {
    throw new Error(`Connection URL must use role "${expectedRole}", got "${role}"`);
  }
  return {
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

/**
 * Creates or updates the three roles and makes app_migrator own the database
 * (and so its public schema). Idempotent. Runs as a superuser: locally and in
 * CI from Compose, in production once from the runbook.
 */
export async function bootstrapRoles(urls: DatabaseUrls): Promise<void> {
  const migrator = credentials(urls.migrator, ROLES.migrator);
  const user = credentials(urls.user, ROLES.user);
  const platform = credentials(urls.platform, ROLES.platform);

  const client = new pg.Client({ connectionString: urls.superuser });
  await client.connect();
  try {
    const roles: [string, string, string][] = [
      [ROLES.migrator, migrator.password, 'BYPASSRLS'],
      [ROLES.user, user.password, 'NOBYPASSRLS'],
      [ROLES.platform, platform.password, 'NOBYPASSRLS'],
    ];
    for (const [name, password, rls] of roles) {
      const exists = await client.query('select 1 from pg_roles where rolname = $1', [name]);
      const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
      await client.query(
        `${verb} ROLE ${client.escapeIdentifier(name)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${rls} PASSWORD ${client.escapeLiteral(password)}`,
      );
    }
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(migrator.database)} OWNER TO ${ROLES.migrator}`,
    );
  } finally {
    await client.end();
  }

  // pgvector is not a trusted extension, so only a superuser can create it,
  // and it must exist in the application database before migrations run.
  const appDb = new pg.Client({
    connectionString: withDatabase(urls.superuser, migrator.database),
  });
  await appDb.connect();
  try {
    await appDb.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await appDb.end();
  }
}

/** Applies pending migrations as app_migrator. */
export async function migrate(migratorUrl: string): Promise<void> {
  credentials(migratorUrl, ROLES.migrator);
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await runMigrations(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

/** Drops and recreates a database. Integration tests only. */
export async function recreateDatabase(superuserUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    const name = client.escapeIdentifier(database);
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

/** Returns the same connection URL pointing at another database. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
