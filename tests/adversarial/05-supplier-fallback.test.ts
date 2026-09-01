/**
 * Acceptance criterion 5.
 *
 * "Поставщик A недоступен, fallback на B, товар выдан ровно один раз."
 *
 * The distinction that matters here is between the two ways A can be down. When
 * A answers and refuses, nothing was issued and failing over is free. When A
 * does not answer at all, failing over is still right for the customer but
 * leaves a claim that has to be chased, which is why those cases are separated.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

describe('criterion 5: supplier A unavailable, fallback to B', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('fails over when A refuses, and issues exactly one code', async () => {
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'error' });
    await harness.chaos(SUPPLIER_B, { forced_outcome: null });

    const { orderId, amount } = await harness.createOrder('KEY-GTA5');
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_fallback_${orderId}` }),
    });
    await harness.drain();

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered');
    assert.equal((order['delivery'] as { supplier: string }).supplier, SUPPLIER_B);

    assert.equal(await harness.issuanceCount(SUPPLIER_A, orderId), 0, 'a refusing supplier must not have issued anything');
    assert.equal(await harness.issuanceCount(SUPPLIER_B, orderId), 1, 'the fallback must have issued exactly one code');

    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1);

    // A's request is closed as definitively failed, so there is nothing left to
    // reconcile and the report stays clean.
    const requests = await harness.pool.query<{ supplier: string; state: string }>(
      'SELECT supplier, state FROM supplier_requests WHERE order_id = $1 ORDER BY supplier',
      [orderId],
    );
    assert.deepEqual(
      requests.rows,
      [
        { supplier: SUPPLIER_A, state: 'failed_definitive' },
        { supplier: SUPPLIER_B, state: 'succeeded' },
      ],
      'a served refusal is definitive, not an open claim',
    );

    const report = await harness.api.inject({
      url: '/admin/reconciliation',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(report.statusCode, 200, 'reconciliation must report healthy after a clean fallback');
  });

  it('still delivers when both suppliers are refusing but one recovers', async () => {
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'error' });
    await harness.chaos(SUPPLIER_B, { forced_outcome: 'error' });

    const { orderId, amount } = await harness.createOrder('SUB-YT-3M');
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_bothdown_${orderId}` }),
    });
    await harness.drain();

    let order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivery_failed', 'both suppliers down leaves a recoverable state, not a crash');
    assert.equal(order['delivery'], null);

    // The customer has paid, so the order must not be abandoned. Once a supplier
    // is healthy again the recovery sweep drives it to completion.
    await harness.chaos(SUPPLIER_B, { forced_outcome: null });
    await harness.container.useCases.recoverStuckOrders.execute();
    await harness.drain();

    order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered', 'recovery must finish an order that was left in delivery_failed');
    assert.equal((order['delivery'] as { supplier: string }).supplier, SUPPLIER_B);
    assert.equal(await harness.issuanceCount(SUPPLIER_A, orderId), 0);
    assert.equal(await harness.issuanceCount(SUPPLIER_B, orderId), 1, 'recovery must not issue a second code');
  });
});
