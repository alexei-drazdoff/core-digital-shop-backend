/**
 * Backoff schedule.
 *
 * Randomness is injected, so both the bounds and the jitter are asserted instead
 * of hoped for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs } from '../../src/application/retry-policy.js';

describe('supplier backoff', () => {
  it('grows exponentially and then stops at the ceiling', () => {
    // random() at its maximum makes the delay equal the full window, which is
    // where the exponential shape and the cap are visible.
    const atMax = (attempt: number) => backoffDelayMs(attempt, { baseMs: 100, maxMs: 800, random: () => 0.999999 });
    assert.equal(atMax(1), 99);
    assert.equal(atMax(2), 199);
    assert.equal(atMax(3), 399);
    assert.equal(atMax(4), 799);
    assert.equal(atMax(5), 799, 'the ceiling must hold however many attempts have passed');
  });

  it('uses full jitter, so a recovering supplier is not hit by a synchronised retry storm', () => {
    const options = { baseMs: 100, maxMs: 800 };
    assert.equal(backoffDelayMs(3, { ...options, random: () => 0 }), 0, 'the low end of the window must be reachable');

    const samples = Array.from({ length: 200 }, () => backoffDelayMs(3, options));
    assert.equal(
      samples.every((delay) => delay >= 0 && delay < 400),
      true,
      'every sample must fall inside the window for that attempt',
    );
    assert.ok(new Set(samples).size > 20, 'delays must actually be spread out, not clustered');
  });

  it('never returns a negative delay for a nonsensical attempt number', () => {
    assert.ok(backoffDelayMs(0, { baseMs: 100, maxMs: 800 }) >= 0);
    assert.ok(backoffDelayMs(-5, { baseMs: 100, maxMs: 800 }) >= 0);
  });
});
