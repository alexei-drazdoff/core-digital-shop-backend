import type { Executor } from '../../infrastructure/db/pool.js';
import type { TransactionScope } from '../../infrastructure/db/unit-of-work.js';

export const JOB_KINDS = ['deliver_order', 'reconcile_supplier_request', 'apply_deferred_event'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface EnqueueRequest {
  readonly kind: JobKind;
  /** Collapses concurrent duplicate enqueues of the same work into one live job. */
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
}

export interface JobQueue {
  /**
   * Enqueues inside the caller's transaction.
   *
   * Taking a TransactionScope rather than a pool is the whole point: the job and
   * the state change that justifies it commit together or not at all. That is
   * the transactional outbox guarantee, and it is why the queue lives in
   * Postgres instead of a separate broker.
   */
  enqueue(tx: TransactionScope, request: EnqueueRequest): Promise<boolean>;
  /** Claims up to `limit` due jobs with FOR UPDATE SKIP LOCKED. */
  claim(exec: Executor, workerId: string, limit: number): Promise<readonly Job[]>;
  complete(exec: Executor, jobId: number): Promise<void>;
  /** Reschedules with backoff, or marks the job dead once attempts run out. */
  fail(exec: Executor, jobId: number, error: string, retryAfter: Date | null): Promise<void>;
  /** Returns jobs abandoned by a crashed worker to the pending pool. */
  requeueAbandoned(exec: Executor, olderThan: Date): Promise<number>;
}
