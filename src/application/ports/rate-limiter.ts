/**
 * The supplier rate limit.
 *
 * A port rather than a helper because the limit belongs to the supplier and is
 * shared by every worker: a per-process limiter would let N workers each send
 * the agreed rate and the supplier would receive N times it, which is the exact
 * failure this exists to prevent. The only implementation that can be correct is
 * one backed by shared state, so the interface says so.
 */
import type { Executor } from '../../infrastructure/db/pool.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** When to come back, if refused. Derived from the refill rate, not guessed. */
  readonly retryAfter: Date;
  /** Whole tokens left after the decision. For the progress endpoint. */
  readonly remaining: number;
}

export interface SupplierRateLimiter {
  /**
   * Takes one token if there is one, in a single atomic statement.
   *
   * Must not be a read followed by a write: two workers reading "1 token left"
   * would both proceed and the limit would be exceeded by exactly the amount
   * that matters. Refusal is not an error and must be cheap, because under a
   * burst it is the common case.
   */
  tryConsume(exec: Executor, supplier: string): Promise<RateLimitDecision>;
  /** Current tokens per supplier, for the progress endpoint. */
  snapshot(exec: Executor): Promise<ReadonlyArray<{ supplier: string; tokens: number; capacity: number }>>;
}
