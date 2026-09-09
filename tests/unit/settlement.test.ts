/**
 * The money invariant, tested where it is arithmetic.
 *
 * "По деньгам всегда сходится: оплачено равно выдано плюс возвращено" is a claim
 * about a pure function, so it is checked here without a database. Everything
 * downstream — the ledger groups, the /admin/money report, the per-order view —
 * is a different way of asking the same question, and they all have to agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSettles,
  settle,
  UnbalancedSettlementError,
  type SettlementLine,
} from '../../src/domain/order/settlement.js';

const line = (id: string, status: SettlementLine['status'], priceMinor: number): SettlementLine => ({
  id,
  status,
  priceMinor,
});

describe('order settlement', () => {
  it('splits a fully delivered basket entirely into delivered', () => {
    const result = settle(1500, [line('a', 'delivered', 1000), line('b', 'delivered', 500)]);
    assert.deepEqual(
      { delivered: result.deliveredMinor, refunded: result.refundableMinor, unresolved: result.unresolvedMinor },
      { delivered: 1500, refunded: 0, unresolved: 0 },
    );
    assert.equal(result.balances, true);
  });

  it('splits a partially delivered basket across delivered and refunded', () => {
    const result = settle(1500, [line('a', 'delivered', 1000), line('b', 'refunded', 500)]);
    assert.equal(result.deliveredMinor, 1000);
    assert.equal(result.refundableMinor, 500);
    assert.equal(result.unresolvedMinor, 0);
    // The assignment's sentence, as an equation.
    assert.equal(result.deliveredMinor + result.refundableMinor, result.paidMinor);
  });

  it('counts everything not yet resolved as in flight rather than as either outcome', () => {
    const result = settle(1500, [line('a', 'delivered', 1000), line('b', 'out_of_stock', 500)]);
    assert.equal(result.unresolvedMinor, 500, 'a line still being tried is neither delivered nor refunded');
    assert.equal(result.balances, true, 'the identity holds mid flight too, with the third term non zero');
  });

  it('treats every non final line status as unresolved', () => {
    for (const status of ['pending', 'delivering', 'out_of_stock', 'delivery_failed'] as const) {
      const result = settle(700, [line('a', status, 700)]);
      assert.equal(result.unresolvedMinor, 700, `${status} must not be counted as settled`);
      assert.equal(result.deliveredMinor + result.refundableMinor, 0);
    }
  });

  it('refuses a basket whose lines disagree with what was paid', () => {
    // The only way this happens is a pricing defect at order creation, and
    // paying out against it would turn a bug into a loss.
    const wrong = settle(2000, [line('a', 'delivered', 1000), line('b', 'refunded', 500)]);
    assert.equal(wrong.balances, false);
    assert.throws(() => assertSettles('ord_1', wrong), UnbalancedSettlementError);
  });

  it('names the order and the numbers when it refuses, so the defect is findable', () => {
    assert.throws(
      () => assertSettles('ord_broken', settle(2000, [line('a', 'delivered', 1000)])),
      (error: Error) => {
        assert.ok(error instanceof UnbalancedSettlementError);
        assert.match(error.message, /ord_broken/);
        assert.match(error.message, /2000/);
        return true;
      },
    );
  });

  it('settles an empty basket to nothing, and only when nothing was paid', () => {
    assert.equal(settle(0, []).balances, true);
    assert.equal(settle(100, []).balances, false, 'money paid with no lines behind it cannot balance');
  });
});
