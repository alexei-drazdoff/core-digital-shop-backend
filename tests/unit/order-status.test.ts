/**
 * The order state machine.
 *
 * Pure, so it is tested exhaustively rather than by example: every status pair
 * is checked against the allowed set, which is what stops a future edit from
 * quietly opening a path out of a final state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUSES,
  awaitsDelivery,
  canTransition,
  decidePaymentEffect,
  isRecoverable,
  isTerminal,
  assertTransition,
  InvalidTransitionError,
  type OrderStatus,
} from '../../src/domain/order/status.js';

const ALLOWED: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  ['created', 'paid'],
  ['created', 'payment_failed'],
  ['paid', 'delivering'],
  ['delivering', 'delivered'],
  ['delivering', 'out_of_stock'],
  ['delivering', 'delivery_failed'],
  ['out_of_stock', 'delivering'],
  ['delivery_failed', 'delivering'],
];

describe('order state machine', () => {
  it('permits exactly the documented transitions and nothing else', () => {
    const allowed = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        assert.equal(
          canTransition(from, to),
          allowed.has(`${from}->${to}`),
          `${from} -> ${to} disagrees with the documented state machine`,
        );
      }
    }
  });

  it('lets nothing leave a final state', () => {
    for (const terminal of ORDER_STATUSES.filter(isTerminal)) {
      for (const to of ORDER_STATUSES) {
        assert.equal(canTransition(terminal, to), false, `${terminal} must be final`);
      }
    }
  });

  it('treats out_of_stock and delivery_failed as recoverable, and only those', () => {
    const recoverable = ORDER_STATUSES.filter(isRecoverable);
    assert.deepEqual([...recoverable].sort(), ['delivery_failed', 'out_of_stock']);
    // Both must lead back into delivery, or a paid customer would be stranded.
    for (const status of recoverable) assert.equal(canTransition(status, 'delivering'), true);
  });

  it('knows which statuses still owe the customer a code', () => {
    assert.deepEqual(
      ORDER_STATUSES.filter(awaitsDelivery).sort(),
      ['delivering', 'delivery_failed', 'out_of_stock', 'paid'],
    );
  });

  it('throws with both statuses named when an illegal transition is attempted', () => {
    assert.throws(() => assertTransition('delivered', 'paid'), (error: Error) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.match(error.message, /delivered/);
      assert.match(error.message, /paid/);
      return true;
    });
  });
});

describe('payment event decisions', () => {
  it('moves a new order to paid, and a new order only', () => {
    assert.deepEqual(decidePaymentEffect('created', 'paid'), { kind: 'apply', nextStatus: 'paid' });
    // Anything past created has already been acted on, so a second success is
    // stale information rather than a second payment.
    for (const status of ['paid', 'delivering', 'out_of_stock', 'delivery_failed'] as const) {
      assert.deepEqual(decidePaymentEffect(status, 'paid'), { kind: 'ignore', outcome: 'ignored_stale' });
    }
  });

  it('never disturbs a final order', () => {
    for (const status of ORDER_STATUSES.filter(isTerminal)) {
      for (const event of ['paid', 'failed'] as const) {
        assert.deepEqual(decidePaymentEffect(status, event), { kind: 'ignore', outcome: 'ignored_terminal' });
      }
    }
  });

  it('only honours a failure while the order is still awaiting payment', () => {
    assert.deepEqual(decidePaymentEffect('created', 'failed'), { kind: 'apply', nextStatus: 'payment_failed' });
    // Once delivery is under way the money is confirmed. A late failure event
    // arriving out of order must not claw back goods already promised.
    for (const status of ['paid', 'delivering', 'out_of_stock', 'delivery_failed'] as const) {
      assert.deepEqual(decidePaymentEffect(status, 'failed'), { kind: 'ignore', outcome: 'ignored_stale' });
    }
  });
});
