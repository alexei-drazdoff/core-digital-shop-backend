/**
 * Acceptance criterion 2.
 *
 * "Повторный вебхук с тем же event_id ничего не меняет."
 *
 * The same event id delivered fifty times at once, then again after the order
 * has already been delivered. Nothing may move on any of the repeats, and the
 * check is made against timestamps rather than status alone: an order that ends
 * in the right state but was rewritten five times is still a bug.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

describe('criterion 2: replaying one event id changes nothing', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('stores one event, applies it once, and is inert on every repeat', async () => {
    const { orderId, amount } = await harness.createOrder('GIFT-PSN-1000');
    const payload = buildPayload({ orderId, amount, eventId: 'evt_the_only_one' });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => harness.api.inject({ method: 'POST', url: '/webhooks/payment', payload })),
    );

    const outcomes = responses.map((response) => (response.json() as { outcome: string }).outcome);
    assert.equal(outcomes.filter((outcome) => outcome === 'applied').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === 'duplicate').length, 49);

    const stored = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM payment_events WHERE order_id = $1',
      [orderId],
    );
    assert.equal(stored.rows[0]?.count, 1, 'a repeated event id may only ever be one row');

    await harness.drain();
    const settled = await harness.pool.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM orders WHERE id = $1',
      [orderId],
    );
    const before = settled.rows[0];
    assert.equal(before?.status, 'delivered');

    // Replay again now that the order is final. A late duplicate must not
    // disturb a completed order, not even its updated_at.
    const late = await Promise.all(
      Array.from({ length: 10 }, () => harness.api.inject({ method: 'POST', url: '/webhooks/payment', payload })),
    );
    assert.equal(
      late.every((response) => response.statusCode === 200),
      true,
    );

    const after = await harness.pool.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM orders WHERE id = $1',
      [orderId],
    );
    assert.equal(after.rows[0]?.status, 'delivered');
    assert.equal(
      after.rows[0]?.updated_at.getTime(),
      before?.updated_at.getTime(),
      'a duplicate must not even touch updated_at',
    );

    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1);
  });

  it('rejects a payment whose amount disagrees with the order', async () => {
    const { orderId, amount } = await harness.createOrder('SUB-DISCORD-1M');
    const response = await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount: amount + 100, eventId: 'evt_wrong_amount' }),
    });

    // Still a 200, because the event was received and recorded. What must not
    // happen is the order moving on the strength of a payload that disagrees
    // with the price.
    assert.equal(response.statusCode, 200);
    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'created', 'a mismatched amount must not mark the order paid');

    const recorded = await harness.pool.query<{ outcome: string }>(
      'SELECT outcome FROM payment_events WHERE event_id = $1',
      ['evt_wrong_amount'],
    );
    assert.equal(recorded.rows[0]?.outcome, 'amount_mismatch');
  });
});
