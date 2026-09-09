import type { Executor } from '../db/pool.js';
import type { RateLimitDecision, SupplierRateLimiter } from '../../application/ports/rate-limiter.js';

/**
 * Refill accrued since the row was last touched, capped at the burst size.
 *
 * Computed from elapsed time on read rather than by a background ticker: there
 * is nothing to run, nothing to drift, and a bucket idle for an hour is correct
 * the first time anybody asks.
 *
 * The cap is what stops an idle period being cashed in as one enormous spike at
 * the supplier, which would respect the average rate while violating the thing
 * the supplier actually cares about.
 */
const AVAILABLE = `LEAST(
  capacity::numeric,
  tokens + (EXTRACT(EPOCH FROM (now() - updated_at)) / 60.0) * refill_per_minute
)`;

/**
 * A token bucket held in Postgres.
 *
 * Shared state rather than per-process, because the limit belongs to the
 * SUPPLIER and workers are horizontally scaled: a limiter living in each worker
 * would let N workers each send the agreed rate and the supplier would receive N
 * times it, which is precisely the failure this exists to prevent.
 *
 * Taking a token is a CONDITIONAL UPDATE, the same idiom the order state machine
 * uses, and for the same reason: the database decides the winner. Computing the
 * available tokens and then spending them in two statements would leave a window
 * where two workers both see the last token and both proceed — and it would only
 * ever happen under load, which is to say only in production.
 *
 * A refusal touches nothing. It is a plain read, so the common case under a
 * burst adds no write contention, and the accrual clock is not disturbed by the
 * callers who were turned away.
 */
export class PgSupplierRateLimiter implements SupplierRateLimiter {
  async tryConsume(exec: Executor, supplier: string): Promise<RateLimitDecision> {
    // The condition lives in the WHERE clause, so it is re-evaluated against the
    // locked row after any concurrent update. Exactly one of N racing callers
    // can match on the last token.
    const taken = await exec.query<{ tokens: string; refill_per_minute: number }>(
      `UPDATE supplier_rate_limits
          SET tokens = ${AVAILABLE} - 1,
              updated_at = now()
        WHERE supplier = $1
          AND ${AVAILABLE} >= 1
       RETURNING tokens, refill_per_minute`,
      [supplier],
    );

    const granted = taken.rows[0];
    if (granted) {
      return { allowed: true, retryAfter: new Date(), remaining: Math.floor(Number(granted.tokens)) };
    }

    // Either there was no capacity, or there is no such supplier. The two need
    // different answers, so they are distinguished rather than guessed at.
    const state = await exec.query<{ tokens: string; refill_per_minute: number }>(
      `SELECT ${AVAILABLE} AS tokens, refill_per_minute FROM supplier_rate_limits WHERE supplier = $1`,
      [supplier],
    );

    const row = state.rows[0];
    if (!row) {
      // No row means nobody configured a limit for this supplier. Unlimited is
      // the right reading: a missing configuration must not silently stop
      // delivery, and refusing would take the system down the first time
      // somebody added a third supplier.
      return { allowed: true, retryAfter: new Date(), remaining: Number.POSITIVE_INFINITY };
    }

    // When to come back, derived from the refill rate rather than a fixed
    // backoff, so the queue returns exactly when there is something to return
    // for instead of hammering or oversleeping.
    const tokens = Number(row.tokens);
    const secondsToNextToken = row.refill_per_minute > 0 ? (60 / row.refill_per_minute) * Math.max(0, 1 - tokens) : 60;

    return {
      allowed: false,
      retryAfter: new Date(Date.now() + Math.max(1, Math.ceil(secondsToNextToken * 1000))),
      remaining: Math.floor(tokens),
    };
  }

  async snapshot(exec: Executor): Promise<ReadonlyArray<{ supplier: string; tokens: number; capacity: number }>> {
    const result = await exec.query<{ supplier: string; tokens: string; capacity: number }>(
      `SELECT supplier, ${AVAILABLE} AS tokens, capacity FROM supplier_rate_limits ORDER BY supplier`,
    );
    return result.rows.map((row) => ({
      supplier: row.supplier,
      tokens: Math.floor(Number(row.tokens)),
      capacity: row.capacity,
    }));
  }
}
