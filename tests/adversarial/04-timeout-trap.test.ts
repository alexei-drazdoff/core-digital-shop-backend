/**
 * Acceptance criterion 4.
 *
 * "Таймаут поставщика, который на самом деле выдал код, повтор не создает
 *  вторую выдачу (тот же request_id)."
 *
 * This is the assignment's central trap, so the test is built to actually spring
 * it rather than to simulate it. The supplier stub runs on a real socket, and it
 * is configured to issue the code and only then withhold the response. The
 * client therefore sees a genuine timeout for a call that really did succeed.
 *
 * What must hold afterwards: the retry carries the SAME request_id, the supplier
 * has issued exactly one code, and the customer gets that code once.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';
import { supplierRequestId } from '../../src/domain/order/order.js';

describe('criterion 4: a timeout is not a refusal', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('recovers the code the supplier had already issued, without issuing a second one', async () => {
    // Issue the code, then hang for longer than the client timeout. The 504 the
    // stub eventually returns is never seen: the socket has already timed out.
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'timeout', hang_ms: 3000, issue_before_hang: true });

    const { orderId, amount } = await harness.createOrder('KEY-EFT');
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_trap_${orderId}` }),
    });

    // The retry must reach a healthy supplier A, otherwise the test would prove
    // only that the fallback works. Clearing the fault mid-flight is not
    // possible, so the stub answers the repeat from its issuance table, which is
    // exactly the contract behaviour being relied on in production.
    await harness.drain();

    const attempts = await harness.pool.query<{ attempt_no: number; supplier: string; request_id: string; outcome: string }>(
      'SELECT attempt_no, supplier, request_id, outcome FROM delivery_attempts WHERE order_id = $1 ORDER BY id',
      [orderId],
    );

    const expectedRequestId = supplierRequestId(orderId, SUPPLIER_A);
    const attemptsAtA = attempts.rows.filter((row) => row.supplier === SUPPLIER_A);

    assert.ok(attemptsAtA.length >= 2, 'supplier A must have been retried after the timeout');
    assert.equal(attemptsAtA[0]?.outcome, 'timeout', 'the first attempt must be recorded as a timeout, not a refusal');
    assert.equal(
      attemptsAtA.every((row) => row.request_id === expectedRequestId),
      true,
      'every retry must reuse the same request id, or the supplier would mint a second code',
    );

    // The load bearing assertion. The supplier's own books show one code.
    const issuedAtA = await harness.issuanceCount(SUPPLIER_A, orderId);
    const issuedAtB = await harness.issuanceCount(SUPPLIER_B, orderId);
    assert.equal(issuedAtA, 1, 'supplier A must have issued exactly one code despite the timeout and the retry');
    assert.equal(issuedAtA + issuedAtB, 1, 'no second code may be issued anywhere');

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered');
    const delivery = order['delivery'] as { code: string; supplier: string };
    assert.equal(delivery.supplier, SUPPLIER_A, 'the recovered code came from A, so the fallback must not have been used');

    // And the code the customer holds is the very one the supplier minted before it went quiet.
    const supplierCode = await harness.pool.query<{ code: string }>(
      'SELECT code FROM supplier_stub.issuances WHERE request_id = $1',
      [expectedRequestId],
    );
    assert.equal(delivery.code, supplierCode.rows[0]?.code, 'the delivered code must be the one already issued');

    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1);
    assert.equal(await orphanCount(harness, orderId), 0, 'nothing was wasted, so nothing should be written off');
  });

  it('records an orphan when a timed out supplier is only discovered later', async () => {
    // Supplier A issues and goes quiet for longer than the delivery path is
    // willing to wait, so the order is served by B. A's code is real stock that
    // was consumed with no sale behind it, and the reconciler has to find it.
    await harness.chaos(SUPPLIER_A, {
      forced_outcome: 'timeout',
      hang_ms: 60_000,
      issue_before_hang: true,
      // Unreachable even for a repeat, so the already issued code stays stranded
      // and the fallback is genuinely required.
      hang_before_lookup: true,
    });
    await harness.chaos(SUPPLIER_B, { forced_outcome: null });

    const { orderId, amount } = await harness.createOrder('KEY-CS2-PRIME');
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_orphan_${orderId}` }),
    });
    await harness.drain();

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered', 'the customer must be served by the fallback, not left waiting');
    assert.equal((order['delivery'] as { supplier: string }).supplier, SUPPLIER_B);

    // Supplier A really did burn a key.
    assert.equal(await harness.issuanceCount(SUPPLIER_A, orderId), 1);
    assert.equal(await harness.issuanceCount(SUPPLIER_B, orderId), 1);

    // Now let A answer, and run the reconciliation the delivery path scheduled.
    await harness.chaos(SUPPLIER_A, { forced_outcome: null, hang_before_lookup: false });
    await harness.pool.query(`UPDATE jobs SET run_after = now() WHERE kind = 'reconcile_supplier_request'`);
    await harness.drain();

    assert.equal(await orphanCount(harness, orderId), 1, 'the wasted code must be recorded, not lost');

    // Still exactly one delivery: the recovered code was written off, not handed over twice.
    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1);

    // The write off is journalled, so the books still balance.
    const shrinkage = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger_entries WHERE order_id = $1 AND account = 'shrinkage'`,
      [orderId],
    );
    assert.equal(shrinkage.rows[0]?.count, 1, 'an orphaned issuance must appear in the money journal as shrinkage');
    await assertLedgerBalanced(harness);
  });
});

async function orphanCount(harness: Harness, orderId: string): Promise<number> {
  const result = await harness.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM orphan_issuances WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0]?.count ?? 0;
}

async function assertLedgerBalanced(harness: Harness): Promise<void> {
  const result = await harness.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT group_id FROM ledger_entries GROUP BY group_id HAVING sum(signed_minor) <> 0
     ) AS unbalanced`,
  );
  assert.equal(result.rows[0]?.count, 0, 'every ledger group must net to zero');
}
