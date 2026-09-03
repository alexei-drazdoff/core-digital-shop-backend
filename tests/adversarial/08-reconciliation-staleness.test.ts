/**
 * Regression: the reconciliation report must not be blinded by its own retries.
 *
 * "Оплачен, но не выдан" was measured from orders.updated_at, the same column
 * the stuck order sweep scans. Every retry transitions the status and rewrites
 * updated_at, so an order nobody can deliver kept dropping back out of the
 * window and the endpoint kept answering healthy while the customer waited.
 *
 * The test runs with a real staleness threshold rather than the harness default
 * of zero. With a zero threshold every row is stale the instant it is written,
 * which is precisely why the original bug survived the rest of the suite.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, INTENTIONALLY_EMPTY_SKU } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };

describe('reconciliation staleness is measured from the payment, not the last retry', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness({ STUCK_ORDER_AFTER_MS: '30000' });
  });
  after(async () => {
    await harness.stop();
  });

  const report = async (): Promise<{ statusCode: number; body: { healthy: boolean; paid_not_delivered: Array<{ orderId: string }> } }> => {
    const response = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    return { statusCode: response.statusCode, body: response.json() as never };
  };

  it('keeps reporting an undeliverable paid order after the sweep has retried it', async () => {
    const { orderId, amount } = await harness.createOrder(INTENTIONALLY_EMPTY_SKU);
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_stale_${orderId}` }),
    });
    await harness.drain();
    assert.equal((await harness.getOrder(orderId))['status'], 'out_of_stock');

    // Fresher than the threshold, so the report is right to stay quiet: the
    // worker is still on it, and a discrepancy that is seconds old is not one.
    const quiet = await report();
    assert.equal(quiet.statusCode, 200, 'a payment taken moments ago is not yet a discrepancy');

    // Age the order past the threshold. The customer paid five minutes ago.
    await harness.pool.query(
      `UPDATE orders SET paid_at = now() - interval '5 minutes', updated_at = now() - interval '5 minutes'
        WHERE id = $1`,
      [orderId],
    );
    const noticed = await report();
    assert.equal(noticed.statusCode, 409, 'five minutes paid with nothing delivered is a discrepancy');
    assert.deepEqual(
      noticed.body.paid_not_delivered.map((row) => row.orderId),
      [orderId],
    );

    // Now let the recovery path do what it does every scan: retry, fail again on
    // an empty pool, and write updated_at = now() on the way through. Nothing
    // about the customer's situation improved.
    await harness.api.inject({ method: 'POST', url: `/admin/orders/${orderId}/redeliver`, headers: ADMIN });
    await harness.drain();
    assert.equal((await harness.getOrder(orderId))['status'], 'out_of_stock', 'the retry cannot succeed, the pool is empty');

    const touched = await harness.pool.query<{ updated_at: Date; paid_at: Date }>(
      'SELECT updated_at, paid_at FROM orders WHERE id = $1',
      [orderId],
    );
    const row = touched.rows[0];
    assert.ok(row, 'the order must still exist');
    assert.ok(
      row.updated_at.getTime() > row.paid_at.getTime() + 60_000,
      'the retry must have refreshed updated_at, otherwise this test proves nothing',
    );

    const afterRetry = await report();
    assert.equal(afterRetry.statusCode, 409, 'a retry that changed nothing must not clear the discrepancy');
    assert.deepEqual(
      afterRetry.body.paid_not_delivered.map((row) => row.orderId),
      [orderId],
      'the order the sweep keeps failing to fix is exactly the one the report must show',
    );
    assert.equal(afterRetry.body.healthy, false);
  });

  it('clears the order from the report once it is actually delivered', async () => {
    const stuck = await harness.pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'out_of_stock' LIMIT 1`,
    );
    const orderId = stuck.rows[0]?.id;
    assert.ok(orderId, 'the previous test leaves one undelivered order behind');

    await harness.api.inject({
      method: 'POST',
      url: '/admin/inventory/replenish',
      headers: ADMIN,
      payload: { sku: INTENTIONALLY_EMPTY_SKU, count: 1 },
    });
    await harness.api.inject({ method: 'POST', url: `/admin/orders/${orderId}/redeliver`, headers: ADMIN });
    await harness.drain();

    assert.equal((await harness.getOrder(orderId))['status'], 'delivered');
    const healthy = await report();
    assert.equal(healthy.statusCode, 200, 'a delivered order is no longer owed to anybody');
    assert.deepEqual(healthy.body.paid_not_delivered, []);
  });
});
