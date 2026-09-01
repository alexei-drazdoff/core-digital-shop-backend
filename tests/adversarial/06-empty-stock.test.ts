/**
 * Acceptance criterion 6.
 *
 * "Пустой остаток, восстановимое состояние, без падения."
 *
 * The SKU used here is seeded with no keys at either supplier, so the empty case
 * is reachable from a clean install with no data surgery. The order must land in
 * out_of_stock rather than error, and must complete by itself once stock returns.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, INTENTIONALLY_EMPTY_SKU, SUPPLIER_A } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

describe('criterion 6: empty stock is recoverable, not a failure', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('parks the order in out_of_stock and delivers it once stock is replenished', async () => {
    // The SKU starts empty, so it must not even be on sale.
    const listing = await harness.api.inject({ url: '/catalog/products?limit=100&in_stock=true' });
    const offered = (listing.json() as { items: Array<{ sku: string }> }).items.map((item) => item.sku);
    assert.equal(offered.includes(INTENTIONALLY_EMPTY_SKU), false, 'an empty SKU must not be offered for sale');

    const { orderId, amount } = await harness.createOrder(INTENTIONALLY_EMPTY_SKU);

    const webhook = await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_empty_${orderId}` }),
    });
    assert.equal(webhook.statusCode, 200, 'an empty pool must not make the webhook fail');
    await harness.drain();

    let order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'out_of_stock', 'an empty pool is a recoverable state, not an error');
    assert.equal(order['delivery'], null);

    // Money in, goods not yet out. The report must say so rather than call this healthy.
    const before = await harness.api.inject({
      url: '/admin/reconciliation',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(before.statusCode, 409, 'an undelivered paid order must be reported as a discrepancy');
    assert.equal((before.json() as { paid_not_delivered: unknown[] }).paid_not_delivered.length, 1);

    // Both suppliers refused with out_of_stock, and both refusals are definitive.
    const requests = await harness.pool.query<{ state: string; failure_reason: string }>(
      'SELECT state, failure_reason FROM supplier_requests WHERE order_id = $1',
      [orderId],
    );
    assert.equal(requests.rowCount, 2);
    assert.equal(
      requests.rows.every((row) => row.state === 'failed_definitive' && row.failure_reason === 'out_of_stock'),
      true,
    );

    // Restock, then let the ordinary recovery path do its job.
    const replenish = await harness.api.inject({
      method: 'POST',
      url: '/admin/inventory/replenish',
      headers: { authorization: 'Bearer test-admin-token' },
      payload: { sku: INTENTIONALLY_EMPTY_SKU, supplier: SUPPLIER_A, count: 3 },
    });
    assert.equal(replenish.statusCode, 200);
    await harness.drain();

    order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered', 'a replenished SKU must let the parked order finish');
    assert.ok((order['delivery'] as { code: string }).code);

    // Exactly one code, even though the delivery path ran more than once.
    assert.equal(await harness.issuanceCount(SUPPLIER_A, orderId), 1, 'recovery must not issue a second code');
    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1);

    const after = await harness.api.inject({
      url: '/admin/reconciliation',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(after.statusCode, 200, 'the discrepancy must clear once the order is delivered');

    // And the restocked SKU is back on sale.
    const refreshed = await harness.api.inject({ url: '/catalog/products?limit=100&in_stock=true' });
    const refreshedSkus = (refreshed.json() as { items: Array<{ sku: string }> }).items.map((item) => item.sku);
    assert.equal(refreshedSkus.includes(INTENTIONALLY_EMPTY_SKU), true, 'restocking must put the SKU back on sale');
  });
});
