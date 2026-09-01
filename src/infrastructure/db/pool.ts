import pg from 'pg';
import type { AppConfig } from '../config/env.js';

const { Pool, types } = pg;

// bigint (OID 20) arrives as a string by default because it can exceed Number.
// Every bigint in this schema is a counter or a minor-unit amount well inside
// the safe integer range, so parsing to number keeps arithmetic honest.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));
// numeric (OID 1700) is only used by aggregate sums in the reconciliation queries.
types.setTypeParser(1700, (value) => Number.parseFloat(value));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Anything that can run a query: the pool itself, or a client bound to an open
 * transaction. Repositories accept this so the exact same code composes inside
 * and outside a transaction.
 */
export interface Executor {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    // A stuck query must not pin a connection forever while 50 webhooks queue behind it.
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'digital-shop-core',
  });
}
