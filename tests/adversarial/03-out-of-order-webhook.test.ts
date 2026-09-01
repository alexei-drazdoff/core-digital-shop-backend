/**
 * Acceptance criterion 3.
 *
 * "Вебхук вне порядка или раньше заказа, обработано корректно."
 *
 * Two shapes of "out of order" are covered. An event that arrives before its
 * order exists must be parked and later applied, and an event that arrives after
 * the order has already moved past it must be recorded without effect.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, uniqueOrderId, type Harness } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

describe('criterion 3: webhooks that arrive early or out of sequence', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('parks an event whose order does not exist yet, then applies it on arrival', async () => {
    const orderId = uniqueOrderId('EARLY');

    const early = await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount: 890, eventId: 'evt_before_the_order' }),
    });

    // 200, not 5xx. The contract asks for a fast acknowledgement, and an event
    // that is simply ahead of its order is not a failure to be retried at us.
    assert.equal(early.statusCode, 200);
    assert.equal((early.json() as { outcome: string }).outcome, 'deferred');

    // Parked means still pending. If processed_at were set here the event would
    // be filed as handled and the order would never be paid.
    const parked = await harness.pool.query<{ outcome: string; processed_at: Date | null }>(
      'SELECT outcome, processed_at FROM payment_events WHERE event_id = $1',
      ['evt_before_the_order'],
    );
    assert.equal(parked.rows[0]?.outcome, 'deferred');
    assert.equal(parked.rows[0]?.processed_at, null, 'a parked event must stay unprocessed');

    await harness.createOrder('GIFT-ROBLOX-800', { orderId });
    await harness.drain();

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered', 'creating the order must settle the parked payment');
    assert.ok((order['delivery'] as { code: string }).code);

    const settled = await harness.pool.query<{ outcome: string; processed_at: Date | null }>(
      'SELECT outcome, processed_at FROM payment_events WHERE event_id = $1',
      ['evt_before_the_order'],
    );
    assert.equal(settled.rows[0]?.outcome, 'applied');
    assert.notEqual(settled.rows[0]?.processed_at, null);
  });

  it('ignores a failure that arrives after the order was already paid', async () => {
    const { orderId, amount } = await harness.createOrder('STEAM-TOPUP-500');

    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: 'evt_paid_first' }),
    });
    await harness.drain();

    // A failure event delivered late, out of order. The money is already
    // confirmed and the goods are gone, so this is stale information, not a
    // reversal instruction.
    const late = await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, status: 'failed', eventId: 'evt_failed_late' }),
    });
    assert.equal(late.statusCode, 200);

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered', 'a late failure must not undo a delivered order');

    const recorded = await harness.pool.query<{ outcome: string }>(
      'SELECT outcome FROM payment_events WHERE event_id = $1',
      ['evt_failed_late'],
    );
    assert.equal(recorded.rows[0]?.outcome, 'ignored_terminal');
  });

  it('marks an order failed when payment fails, and keeps that final', async () => {
    const { orderId, amount } = await harness.createOrder('STEAM-TOPUP-1000');

    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, status: 'failed', eventId: 'evt_declined' }),
    });
    let order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'payment_failed');

    // A success arriving after a decline is out of order too. payment_failed is
    // terminal, so it is recorded and ignored rather than resurrecting the order.
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: 'evt_paid_after_decline' }),
    });
    await harness.drain();

    order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'payment_failed');
    assert.equal(order['delivery'], null, 'a failed payment must never produce a delivery');
  });
});
