/**
 * Stage two, task 1, point 5: "Заказ доходит до конечного состояния даже после
 * аварийной остановки и перезапуска в середине выдачи".
 *
 * A crash is simulated the only way that is honest here: the jobs are left in
 * `running` with nobody holding them, which is exactly the state a killed worker
 * leaves behind. Nothing is rolled back and nothing is cleaned up by the test —
 * the system has to notice and finish the job itself.
 *
 * Two things must hold afterwards. The basket must reach a final state, and it
 * must not have bought a second code for any line while getting there, because
 * "любой шаг можно повторить" is worth nothing if the repeat costs stock.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };
const TERMINAL = new Set(['delivered', 'partially_delivered', 'refunded']);

interface OrderView {
  status: string;
  items: Array<{ order_item_id: string; sku: string; status: string; delivery: { code: string } | null }>;
  money: { paid: number; delivered: number; refunded: number; unresolved: number };
}

describe('stage 2: a basket interrupted mid delivery still reaches a final state', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('finishes the order after a worker dies holding its jobs, without a second issuance', async () => {
    const skus = ['KEY-GTA5', 'GIFT-PSN-1000', 'SUB-DISCORD-1M'];
    const { orderId, amount, itemIds } = await harness.createBasket(skus);

    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_crash_${orderId}` }),
    });

    // Deliver exactly one line, bypassing the queue, so the basket is genuinely
    // half done. Its job stays pending, which is the real shape of the failure:
    // the work happened but nobody got to record that the job was finished.
    const first = itemIds[0];
    assert.ok(first, 'the basket must have lines');
    await harness.container.useCases.deliverOrderItem.execute(first);

    // Now "crash". Every delivery job is marked running and abandoned: claimed
    // by a worker that will never report back. This is the worst moment to die,
    // because the live-job dedupe index counts running rows, so the abandoned
    // jobs also block any re-enqueue for the same lines.
    const abandoned = await harness.pool.query(
      `UPDATE jobs
          SET state = 'running', locked_at = now() - interval '1 hour', locked_by = 'crashed-worker'
        WHERE state = 'pending' AND kind IN ('deliver_order_item', 'settle_order')`,
    );
    assert.ok((abandoned.rowCount ?? 0) >= 3, 'the test needs the delivery jobs to be abandoned');

    const midFlight = (await harness.getOrder(orderId)) as unknown as OrderView;
    assert.equal(TERMINAL.has(midFlight.status), false, 'the order must genuinely be unfinished at this point');

    // Restart. The recovery sweep releases the abandoned jobs and re-drives the
    // lines; nothing else is done by hand.
    for (let round = 0; round < 4; round += 1) {
      await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
      await harness.drain();
    }

    const order = (await harness.getOrder(orderId)) as unknown as OrderView;
    assert.equal(order.status, 'delivered', 'every line was available, so the order must complete');
    assert.equal(order.money.unresolved, 0);
    assert.equal(order.money.delivered + order.money.refunded, order.money.paid);

    // The load bearing assertion: recovery must not have bought a second code.
    for (const itemId of itemIds) {
      const issued =
        (await harness.issuanceCount(SUPPLIER_A, itemId)) + (await harness.issuanceCount(SUPPLIER_B, itemId));
      assert.equal(issued, 1, `line ${itemId} must have consumed exactly one code across both suppliers`);
    }

    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(deliveries.rows[0]?.count, 3, 'one delivery per line, no more');

    const codes = await harness.pool.query<{ count: number }>(
      'SELECT count(DISTINCT code)::int AS count FROM deliveries WHERE order_id = $1',
      [orderId],
    );
    assert.equal(codes.rows[0]?.count, 3, 'three distinct codes, so no code was reused across lines');
  });

  it('never refunds a line a supplier call is still in flight for', async () => {
    // The race this guards against is narrow but it costs real money: a line
    // whose retry budget is spent, being fetched by a worker right now. If
    // settlement refunded it and the worker then committed its delivery, the
    // customer would hold both the code and the money — and because a delivery
    // and a refund are each a correct double entry on their own, no per-account
    // sum would notice.
    //
    // Set up deterministically rather than by racing two workers: `delivering`
    // with the budget spent is exactly the state a concurrent worker produces.
    const { orderId, amount, itemIds } = await harness.createBasket(['KEY-EFT', 'GIFT-XBOX-1500']);
    const [victim] = itemIds;
    assert.ok(victim);

    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_race_${orderId}` }),
    });

    await harness.pool.query(
      `UPDATE order_items SET status = 'delivering', rounds = 99 WHERE id = $1`,
      [victim],
    );

    await harness.container.useCases.settleOrder.execute(orderId);

    const refunded = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM refunds WHERE order_item_id = $1',
      [victim],
    );
    assert.equal(refunded.rows[0]?.count, 0, 'a line being fetched right now must not be refunded');

    const entries = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger_entries WHERE order_item_id = $1 AND ref_type = 'refund'`,
      [victim],
    );
    assert.equal(entries.rows[0]?.count, 0, 'and no refund may have been journalled either');

    // Let it finish for real. The budget being spent must not stop a call that
    // was already in flight from being recorded.
    await harness.drain();
    await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
    await harness.drain();

    const doubled = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM order_items i
         JOIN deliveries d ON d.order_item_id = i.id
         JOIN refunds r ON r.order_item_id = i.id`,
    );
    assert.equal(doubled.rows[0]?.count, 0, 'no line anywhere may be both delivered and refunded');
  });

  it('leaves the reconciliation report healthy', async () => {
    const report = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    const body = report.json() as {
      healthy: boolean;
      double_settled_items: unknown[];
      unsettled_orders: unknown[];
      ledger_imbalances: unknown[];
    };
    assert.deepEqual(body.double_settled_items, [], 'no line may be both delivered and refunded');
    assert.deepEqual(body.unsettled_orders, [], 'no order may have finished its lines without being settled');
    assert.deepEqual(body.ledger_imbalances, []);
    assert.equal(report.statusCode, 200, `reconciliation must be healthy: ${report.body}`);
    assert.equal(body.healthy, true);
  });
});
