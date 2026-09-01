import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { IdempotencyRepository } from '../../../application/ports/repositories.js';

export class PgIdempotencyRepository implements IdempotencyRepository {
  async find(exec: Executor, key: string): Promise<{ requestHash: string; status: number; body: unknown } | null> {
    const result = await exec.query<{ request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? { requestHash: row.request_hash, status: row.response_status, body: row.response_body } : null;
  }

  /**
   * Claims the key and stores the response in the same transaction that creates
   * the order, so a client retrying after a dropped connection gets the original
   * order back rather than a second one it will never see.
   *
   * Returns false when another request already claimed the key.
   */
  async save(
    tx: TransactionScope,
    record: { key: string; requestHash: string; status: number; body: unknown },
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [record.key, record.requestHash, record.status, JSON.stringify(record.body)],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
