/**
 * The token bucket, under concurrency.
 *
 * The limiter is one UPDATE on purpose, and that is the only thing keeping it
 * correct: refilling and spending in two statements would leave a window where
 * two workers both read "one token left" and both proceed. The supplier would
 * receive exactly the extra request the limit exists to prevent, and it would
 * happen only under load — which is to say only in production.
 *
 * So it is asserted rather than argued, against a real database and real
 * concurrent transactions, because that is the only place the property lives.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A } from '../helpers/harness.js';
import { PgSupplierRateLimiter } from '../../src/infrastructure/suppliers/pg-rate-limiter.js';

const limiter = new PgSupplierRateLimiter();

async function setBucket(harness: Harness, tokens: number, refillPerMinute: number): Promise<void> {
  await harness.pool.query(
    `UPDATE supplier_rate_limits
        SET capacity = GREATEST($2::int, 1), refill_per_minute = $3::int,
            tokens = $2::numeric, updated_at = now()
      WHERE supplier = $1`,
    [SUPPLIER_A, tokens, refillPerMinute],
  );
}

describe('the supplier token bucket', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('lets exactly one of many concurrent callers take the last token', async () => {
    // Refill slow enough that nothing is earned during the test, so the only
    // token available is the one that is there at the start.
    await setBucket(harness, 1, 1);

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.tryConsume(harness.pool, SUPPLIER_A)),
    );

    const allowed = decisions.filter((decision) => decision.allowed).length;
    assert.equal(allowed, 1, '20 concurrent callers, one token: exactly one may proceed');
  });

  it('hands out exactly the capacity and no more', async () => {
    await setBucket(harness, 5, 1);

    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => limiter.tryConsume(harness.pool, SUPPLIER_A)),
    );

    assert.equal(
      decisions.filter((decision) => decision.allowed).length,
      5,
      'the bucket must hand out its capacity exactly, however many callers ask at once',
    );
  });

  it('refuses with a retry time derived from the refill rate, not a guess', async () => {
    // 60 per minute is one per second, so a caller refused on an empty bucket
    // should be told to come back in about a second.
    await setBucket(harness, 0, 60);

    const decision = await limiter.tryConsume(harness.pool, SUPPLIER_A);
    assert.equal(decision.allowed, false);

    const waitMs = decision.retryAfter.getTime() - Date.now();
    assert.ok(waitMs > 0 && waitMs <= 1500, `expected roughly one second, got ${waitMs}ms`);
  });

  it('refills over time and caps at the burst size', async () => {
    // An enormous refill rate against a small capacity: after a moment there is
    // capacity available, and never more than capacity.
    await setBucket(harness, 0, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const snapshot = await limiter.snapshot(harness.pool);
    const bucket = snapshot.find((row) => row.supplier === SUPPLIER_A);
    assert.ok(bucket);
    assert.ok(bucket.tokens > 0, 'tokens must accrue with elapsed time, without a ticker running anywhere');
    assert.ok(
      bucket.tokens <= bucket.capacity,
      'an idle period must not be cashable as one enormous spike at the supplier',
    );
  });

  it('treats an unconfigured supplier as unlimited rather than blocked', async () => {
    // A missing configuration must not silently stop delivery. Refusing would
    // take the system down the first time somebody added a third supplier.
    const decision = await limiter.tryConsume(harness.pool, 'supplier_that_does_not_exist');
    assert.equal(decision.allowed, true);
  });
});
