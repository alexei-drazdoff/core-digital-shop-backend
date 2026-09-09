/**
 * The as-of fold.
 *
 * Pure, so the awkward cases are tested exhaustively without a database: an
 * order that did not exist yet, a fact learned long after it happened, an event
 * type this version has never seen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectOrderAt, type OrderEvent } from '../../src/domain/order/projection.js';

const ORDER = 'ord_1';
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds));

let nextId = 1;
function event(
  type: string,
  recordedAtSeconds: number,
  overrides: Partial<OrderEvent> = {},
): OrderEvent {
  return {
    id: nextId++,
    orderId: ORDER,
    orderItemId: null,
    type,
    payload: {},
    occurredAt: at(recordedAtSeconds),
    recordedAt: at(recordedAtSeconds),
    ...overrides,
  };
}

const created = event('order_created', 10, {
  payload: {
    amountMinor: 1500,
    items: [
      { orderItemId: 'itm_a', sku: 'A', priceMinor: 1000 },
      { orderItemId: 'itm_b', sku: 'B', priceMinor: 500 },
    ],
  },
});

const paid = event('payment_captured', 20, { payload: { amountMinor: 1500 } });

const deliveredA = event('item_delivered', 30, {
  orderItemId: 'itm_a',
  payload: { sku: 'A', priceMinor: 1000, supplier: 'supplier_a' },
});

const refundedB = event('item_refunded', 40, {
  orderItemId: 'itm_b',
  payload: { sku: 'B', priceMinor: 500, reason: 'out_of_stock' },
});

const settled = event('order_settled', 41, { payload: { status: 'partially_delivered' } });

const HISTORY = [created, paid, deliveredA, refundedB, settled];

describe('order projection', () => {
  it('reports no state before the order existed', () => {
    const snapshot = projectOrderAt(ORDER, HISTORY, at(5));
    assert.equal(snapshot.status, null, 'the absence of an order is a real answer, not a missing one');
    assert.equal(snapshot.eventsApplied, 0);
    assert.deepEqual(snapshot.items, []);
  });

  it('reconstructs each moment from the facts known by then', () => {
    assert.equal(projectOrderAt(ORDER, HISTORY, at(15)).status, 'created');
    assert.equal(projectOrderAt(ORDER, HISTORY, at(25)).status, 'paid');
    assert.equal(projectOrderAt(ORDER, HISTORY, at(45)).status, 'partially_delivered');
  });

  it('keeps paid = delivered + refunded + unresolved at every point', () => {
    for (const seconds of [15, 25, 35, 45, 100]) {
      const snapshot = projectOrderAt(ORDER, HISTORY, at(seconds));
      assert.equal(
        snapshot.deliveredMinor + snapshot.refundedMinor + snapshot.unresolvedMinor,
        snapshot.paidMinor,
        `the money must add up at ${seconds}s, not only at the end`,
      );
    }
  });

  it('shows the in flight money mid delivery', () => {
    const snapshot = projectOrderAt(ORDER, HISTORY, at(35));
    assert.equal(snapshot.deliveredMinor, 1000);
    assert.equal(snapshot.refundedMinor, 0);
    assert.equal(snapshot.unresolvedMinor, 500, 'the second line was neither delivered nor refunded yet');
  });

  it('folds on when a fact was RECORDED, not when it happened', () => {
    // The out of order webhook, from the history's point of view: the money
    // moved at 20s but we did not hear about it until 90s. At 30s we did not
    // know, and a reconstruction that said otherwise would know the future.
    const late = event('payment_captured', 90, {
      payload: { amountMinor: 1500 },
      occurredAt: at(20),
      recordedAt: at(90),
    });

    const history = [created, late];
    assert.equal(projectOrderAt(ORDER, history, at(30)).paidMinor, 0, 'we had not learned it yet at 30s');
    assert.equal(projectOrderAt(ORDER, history, at(95)).paidMinor, 1500, 'and we had by 95s');
  });

  it('counts an unknown event type without pretending to interpret it', () => {
    // Forward compatibility. A projection from an older deployment must not
    // guess at the meaning of an event a newer one wrote, but it must also not
    // hide that something happened.
    const unknown = event('something_this_version_has_never_seen', 50);
    const snapshot = projectOrderAt(ORDER, [...HISTORY, unknown], at(60));

    assert.equal(snapshot.eventsApplied, HISTORY.length + 1, 'the fact is counted');
    assert.equal(snapshot.status, 'partially_delivered', 'but it changes nothing it does not understand');
  });

  it('records a line the creation event never mentioned rather than dropping it', () => {
    // An incomplete history should read as visibly incomplete, not be silently
    // smoothed over into a plausible one.
    const orphanLine = event('item_delivered', 35, {
      orderItemId: 'itm_c',
      payload: { sku: 'C', priceMinor: 700, supplier: 'supplier_b' },
    });
    const snapshot = projectOrderAt(ORDER, [created, paid, orphanLine], at(60));

    assert.equal(snapshot.items.length, 3);
    assert.ok(snapshot.items.some((item) => item.orderItemId === 'itm_c' && item.status === 'delivered'));
  });

  it('returns an empty reconstruction for an order with no history at all', () => {
    const snapshot = projectOrderAt('ord_unknown', [], at(60));
    assert.equal(snapshot.status, null);
    assert.equal(snapshot.amountMinor, 0);
    assert.deepEqual(snapshot.items, []);
  });
});
