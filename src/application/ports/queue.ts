import type { Executor } from '../../infrastructure/db/pool.js';
import type { TransactionScope } from '../../infrastructure/db/unit-of-work.js';

export const JOB_KINDS = [
  /** Fetch a code for one line of a paid basket. */
  'deliver_order_item',
  /** Decide the fate of a basket once its lines stop moving: refunds and final status. */
  'settle_order',
  'reconcile_supplier_request',
  'apply_deferred_event',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  /** Times this job waited for supplier capacity. Not failures. */
  readonly deferrals: number;
}

/**
 * Higher runs first.
 *
 * "Оплаченные заказы обслуживаются раньше неоплаченных" only bites when supplier
 * capacity is scarce, which is the burst these exist for. Spaced so a kind can
 * be slotted between two of them later without renumbering.
 */
export const JOB_PRIORITY = {
  /** First attempt at a line of a basket the customer has already paid for. */
  PAID_DELIVERY: 200,
  /** Retrying a paid line that failed. Still paid, but somebody else waits behind it. */
  PAID_RETRY: 150,
  /** Everything else: settlement, reconciliation, administrative redelivery. */
  DEFAULT: 100,
} as const;

export interface EnqueueRequest {
  readonly kind: JobKind;
  /** Collapses concurrent duplicate enqueues of the same work into one live job. */
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
  /** Defaults to JOB_PRIORITY.DEFAULT. Higher runs first. */
  readonly priority?: number;
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
  /**
   * Puts a job back WITHOUT spending an attempt.
   *
   * Used when there was no capacity at the supplier to even try. This has to be
   * distinct from `fail`, and it is the difference between "ничего не теряется"
   * being true and being nearly true: `claim` increments attempts
   * unconditionally and `fail` kills a job once they run out, so routing a
   * deferral through it would let a burst of ten times the limit quietly
   * exterminate the jobs at the back of the queue. Nothing was tried, so nothing
   * is charged.
   */
  defer(exec: Executor, jobId: number, runAfter: Date, reason: string): Promise<void>;
  /** Returns jobs abandoned by a crashed worker to the pending pool. */
  requeueAbandoned(exec: Executor, olderThan: Date): Promise<number>;
}
