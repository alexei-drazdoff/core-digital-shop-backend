/**
 * Acceptance criterion 1.
 *
 * "50 параллельных вебхуков оплачено по одному заказу, ровно один факт выдачи,
 *  без потерь и дублей."
 *
 * Fifty DISTINCT event ids for one order, fired simultaneously. Every one of
 * them is a legitimate event that passes the event-id dedupe, so this is the
 * scenario that exercises the order-level race rather than the event-level one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness.js';
import { PaymentSimulator, buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

describe('criterion 1: 50 concurrent webhooks produce exactly one delivery', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('applies one event, ignores the rest, and delivers exactly once', async () => {
    const { orderId, amount } = await harness.createOrder('KEY-GTA5');

    const payloads = Array.from({ length: 50 }, (_, index) =>
      buildPayload({ orderId, amount, eventId: `evt_race_${index}` }),
    );

    // Promise.all, not a loop: the transactions must genuinely overlap.
    const responses = await Promise.all(
      payloads.map((payload) => harness.api.inject({ method: 'POST', url: '/webhooks/payment', payload })),
    );

    // The payment provider must never see a failure, or it would retry forever.
    assert.equal(
      responses.every((response) => response.statusCode === 200),
      true,
      'every webhook must be acknowledged with 200',
    );

    const outcomes = responses.map((response) => (response.json() as { outcome: string }).outcome);
    assert.equal(outcomes.filter((outcome) => outcome === 'applied').length, 1, 'exactly one event may move the order');
    assert.equal(outcomes.filter((outcome) => outcome === 'ignored').length, 49, 'the other 49 must be no-ops');

    await harness.drain();

    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 1, 'exactly one delivery row');

    // All 50 events are recorded. Nothing is lost, which is the other half of
    // the requirement: exactly once, and no silent drops.
    const events = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM payment_events WHERE order_id = $1',
      [orderId],
    );
    assert.equal(events.rows[0]?.count, 50, 'all 50 events must be persisted for the audit trail');

    // The outbox produced exactly one unit of delivery work.
    const jobs = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = $1',
      [`deliver:${orderId}`],
    );
    assert.equal(jobs.rows[0]?.count, 1, 'exactly one delivery job');

    const order = await harness.getOrder(orderId);
    assert.equal(order['status'], 'delivered');
    assert.ok((order['delivery'] as { code: string }).code, 'the customer must have a code');

    // Exactly one code left the supplier's pool for this order.
    const issued = (await harness.issuanceCount('supplier_a', orderId)) + (await harness.issuanceCount('supplier_b', orderId));
    assert.equal(issued, 1, 'suppliers must have issued exactly one code in total');

    const imbalance = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT group_id FROM ledger_entries GROUP BY group_id HAVING sum(signed_minor) <> 0
       ) AS unbalanced`,
    );
    assert.equal(imbalance.rows[0]?.count, 0, 'the money journal must balance');
  });
});
