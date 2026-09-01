/**
 * Double entry construction.
 *
 * The point of building entries through these helpers is that an unbalanced
 * group cannot be constructed at all, so the invariant is a property of the code
 * rather than something the caller has to remember.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBalanced,
  deliveryCostEntries,
  orphanIssuanceEntries,
  paymentCapturedEntries,
  UnbalancedLedgerGroupError,
  type LedgerEntry,
} from '../../src/domain/ledger/entries.js';

const signedTotal = (entries: readonly LedgerEntry[]): number =>
  entries.reduce((total, entry) => total + (entry.direction === 'debit' ? entry.amountMinor : -entry.amountMinor), 0);

describe('ledger entry construction', () => {
  it('produces a balanced group when a payment is captured', () => {
    const entries = paymentCapturedEntries({ orderId: 'ord_1', amountMinor: 1990, currency: 'RUB', eventId: 'evt_1' });
    assert.equal(signedTotal(entries), 0);
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['psp_cash:debit', 'revenue:credit'],
    );
    // Keyed on the event id, so replaying the webhook journals nothing new.
    assert.equal(
      entries.every((entry) => entry.refType === 'payment_event' && entry.refId === 'evt_1'),
      true,
    );
  });

  it('keys delivery cost on the supplier request id, which is stable across retries', () => {
    const entries = deliveryCostEntries({ orderId: 'ord_1', costMinor: 1393, currency: 'RUB', requestId: 'req_1-a' });
    assert.equal(signedTotal(entries), 0);
    assert.equal(
      entries.every((entry) => entry.refType === 'delivery' && entry.refId === 'req_1-a'),
      true,
      'a retried delivery must not double count the cost',
    );
  });

  it('writes an orphaned issuance off as shrinkage, still balanced', () => {
    const entries = orphanIssuanceEntries({ orderId: 'ord_1', costMinor: 903, currency: 'RUB', requestId: 'req_1-a' });
    assert.equal(signedTotal(entries), 0);
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['shrinkage:debit', 'supplier_payable:credit'],
    );
  });

  it('all three groups share one entry shape, so a mixed history still nets to zero', () => {
    const history = [
      ...paymentCapturedEntries({ orderId: 'ord_1', amountMinor: 1990, currency: 'RUB', eventId: 'evt_1' }),
      ...deliveryCostEntries({ orderId: 'ord_1', costMinor: 1393, currency: 'RUB', requestId: 'req_1-a' }),
      ...orphanIssuanceEntries({ orderId: 'ord_1', costMinor: 1393, currency: 'RUB', requestId: 'req_1-b' }),
    ];
    assert.equal(signedTotal(history), 0);
  });

  it('refuses to hand back a group that does not balance', () => {
    const lopsided: LedgerEntry[] = [
      {
        groupId: 'g', orderId: 'ord_1', account: 'psp_cash', direction: 'debit',
        amountMinor: 100, currency: 'RUB', refType: 'test', refId: 'r',
      },
    ];
    assert.throws(() => assertBalanced(lopsided), UnbalancedLedgerGroupError);
  });
});
