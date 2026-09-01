import type { Executor } from '../db/pool.js';
import type { TransactionScope } from '../db/unit-of-work.js';
import type { EnqueueRequest, Job, JobKind, JobQueue } from '../../application/ports/queue.js';

interface JobRow {
  id: number;
  kind: JobKind;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * A queue that lives in the same database as the data it acts on.
 *
 * The reason is atomicity, not simplicity. Enqueueing the delivery job has to
 * commit together with moving the order to paid; with an external broker that
 * enqueue sits outside the database transaction and opens a window where an
 * order is paid with no job, or a job exists for a transaction that rolled back.
 * Sharing one store collapses that into a single COMMIT.
 */
export class PgJobQueue implements JobQueue {
  async enqueue(tx: TransactionScope, request: EnqueueRequest): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO jobs (kind, dedupe_key, payload, run_after, max_attempts)
       VALUES ($1, $2, $3::jsonb, COALESCE($4, now()), COALESCE($5, 10))
       -- Matches the partial unique index on live jobs only, so a completed job
       -- never blocks a later re-enqueue for the same order. Recovery depends on
       -- being able to enqueue again.
       ON CONFLICT (dedupe_key) WHERE state IN ('pending', 'running') DO NOTHING
       RETURNING id`,
      [request.kind, request.dedupeKey, JSON.stringify(request.payload), request.runAfter ?? null, request.maxAttempts ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Claims due jobs.
   *
   * SKIP LOCKED lets N workers pull disjoint batches in one round trip without
   * queueing behind each other, and the UPDATE that marks them running is part
   * of the same statement, so a claimed job cannot be claimed twice.
   */
  async claim(exec: Executor, workerId: string, limit: number): Promise<readonly Job[]> {
    const result = await exec.query<JobRow>(
      `WITH claimed AS (
         SELECT id FROM jobs
          WHERE state = 'pending' AND run_after <= now()
          ORDER BY run_after, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
          SET state = 'running',
              attempts = j.attempts + 1,
              locked_at = now(),
              locked_by = $1,
              updated_at = now()
         FROM claimed
        WHERE j.id = claimed.id
       RETURNING j.id, j.kind, j.dedupe_key, j.payload, j.attempts, j.max_attempts`,
      [workerId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      dedupeKey: row.dedupe_key,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  async complete(exec: Executor, jobId: number): Promise<void> {
    await exec.query(
      `UPDATE jobs SET state = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = $1`,
      [jobId],
    );
  }

  /**
   * A job with retries left goes back to pending with a future run_after. One
   * that has run out becomes dead, which is a visible state the reconciliation
   * report reads, not a silent drop.
   */
  async fail(exec: Executor, jobId: number, error: string, retryAfter: Date | null): Promise<void> {
    await exec.query(
      `UPDATE jobs
          SET state = CASE WHEN $3::timestamptz IS NULL OR attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
              run_after = COALESCE($3, run_after),
              last_error = $2,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
        WHERE id = $1`,
      [jobId, error.slice(0, 2000), retryAfter],
    );
  }

  /**
   * Recovers jobs whose worker died holding them.
   *
   * Without this a crash would leave work stuck in running forever, and because
   * the live-job dedupe index counts running rows, it would also block any
   * re-enqueue for the same order.
   */
  async requeueAbandoned(exec: Executor, olderThan: Date): Promise<number> {
    const result = await exec.query(
      `UPDATE jobs
          SET state = 'pending', locked_at = NULL, locked_by = NULL, run_after = now(), updated_at = now()
        WHERE state = 'running' AND locked_at < $1`,
      [olderThan],
    );
    return result.rowCount ?? 0;
  }
}
