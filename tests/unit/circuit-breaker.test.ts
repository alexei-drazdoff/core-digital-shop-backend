/**
 * Circuit breaker.
 *
 * Time is injected so the cooldown is asserted rather than waited for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/infrastructure/suppliers/circuit-breaker.js';

function breakerAt(clock: { value: number }) {
  return new CircuitBreaker('supplier_a', { failureThreshold: 3, openMs: 1000, now: () => clock.value });
}

describe('circuit breaker', () => {
  it('stays closed until the failure threshold is reached', () => {
    const clock = { value: 0 };
    const breaker = breakerAt(clock);

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.allowsRequest(), true, 'two failures are below the threshold');

    breaker.recordFailure();
    assert.equal(breaker.allowsRequest(), false, 'the third failure must open the circuit');
  });

  it('forgets failures once a call succeeds', () => {
    const clock = { value: 0 };
    const breaker = breakerAt(clock);
    breaker.recordFailure();
    breaker.recordFailure();
    // Consecutive, not cumulative: a healthy call resets the count, so slow
    // background noise cannot accumulate into an outage.
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.allowsRequest(), true);
  });

  it('half opens after the cooldown and lets exactly one probe through', () => {
    const clock = { value: 0 };
    const breaker = breakerAt(clock);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();

    clock.value = 999;
    assert.equal(breaker.allowsRequest(), false, 'the circuit must stay open for the full cooldown');

    clock.value = 1000;
    assert.equal(breaker.allowsRequest(), true, 'the cooldown must expire into a probe');
    assert.equal(breaker.currentState(), 'half_open');
  });

  it('a failed probe reopens immediately rather than spending the threshold again', () => {
    const clock = { value: 0 };
    const breaker = breakerAt(clock);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();

    clock.value = 1000;
    breaker.allowsRequest();
    breaker.recordFailure();

    clock.value = 1001;
    assert.equal(breaker.allowsRequest(), false, 'a still unhealthy supplier must not receive more traffic');
  });

  it('a successful probe closes the circuit', () => {
    const clock = { value: 0 };
    const breaker = breakerAt(clock);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();

    clock.value = 1000;
    breaker.allowsRequest();
    breaker.recordSuccess();
    assert.equal(breaker.currentState(), 'closed');
    assert.equal(breaker.allowsRequest(), true);
  });
});
