import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/env.js';
import { createPool, type Pool } from './pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

async function readMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies pending migrations in file order. Each migration runs inside its own
 * transaction together with its bookkeeping row, so a failure leaves neither a
 * half applied schema nor a lying ledger of what was applied.
 */
export async function migrateUp(pool: Pool, log: (message: string) => void = () => {}): Promise<number> {
  await ensureMigrationsTable(pool);
  const files = await readMigrations();
  const applied = new Map<string, string>(
    (await pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
      (row) => [row.name, row.checksum],
    ),
  );

  let count = 0;
  for (const file of files) {
    const previous = applied.get(file.name);
    if (previous !== undefined) {
      if (previous !== file.checksum) {
        throw new Error(
          `Migration ${file.name} changed after it was applied. Add a new migration instead of editing history.`,
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
      await client.query('COMMIT');
      log(`applied ${file.name}`);
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return count;
}

/**
 * Drops every application schema and re-applies all migrations. Development and
 * test convenience only.
 *
 * It drops all non-system schemas rather than just public, because migrations
 * create their own (supplier_stub). Dropping only public would leave those
 * behind and the next run would fail on an object that already exists.
 */
export async function migrateReset(pool: Pool, log: (message: string) => void = () => {}): Promise<void> {
  const schemas = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        AND nspname NOT LIKE 'pg_temp_%'
        AND nspname NOT LIKE 'pg_toast_temp_%'`,
  );
  for (const { nspname } of schemas.rows) {
    // Identifiers cannot be parameterised, and these names come from the server's
    // own catalog rather than from user input.
    await pool.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
  }
  await pool.query('CREATE SCHEMA public');
  log(`dropped ${schemas.rowCount ?? 0} schema(s)`);
  await migrateUp(pool, log);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const pool = createPool(loadConfig());
  const log = (message: string) => process.stdout.write(`${message}\n`);
  try {
    if (command === 'up') {
      const applied = await migrateUp(pool, log);
      log(applied === 0 ? 'schema is up to date' : `applied ${applied} migration(s)`);
    } else if (command === 'reset') {
      await migrateReset(pool, log);
      log('schema reset');
    } else {
      throw new Error(`Unknown command "${command}". Use "up" or "reset".`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
