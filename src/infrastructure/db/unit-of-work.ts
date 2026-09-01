import type { Executor, Pool, PoolClient } from './pool.js';

export type TransactionScope = Executor & { readonly client: PoolClient };

export interface UnitOfWork {
  /** Runs `fn` inside a single transaction, committing on return and rolling back on throw. */
  withTransaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>;
  readonly executor: Executor;
}

/** Postgres raises this when two transactions deadlock; retrying is the documented fix. */
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const RETRYABLE = new Set<string>([DEADLOCK_DETECTED, SERIALIZATION_FAILURE]);
const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    RETRYABLE.has((error as { code: string }).code)
  );
}

export function createUnitOfWork(pool: Pool): UnitOfWork {
  return {
    executor: pool,
    async withTransaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const scope: TransactionScope = {
            client,
            query: (queryText, values) => client.query(queryText, values as unknown[]),
          };
          const result = await fn(scope);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          lastError = error;
          if (!isRetryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
        } finally {
          client.release();
        }
      }
      throw lastError;
    },
  };
}
