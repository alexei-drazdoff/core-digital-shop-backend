/**
 * Stage two, task 1: "Заказ из нескольких товаров, где часть может не выдаться".
 *
 * A basket of three lines where one SKU has no keys anywhere. The requirement is
 * that the order finishes HONESTLY: the two codes that could be fetched stay
 * with the customer, the money for the third comes back, and paid equals
 * delivered plus refunded.
 *
 * The empty SKU is seeded empty at both suppliers, so this is reachable from a
 * clean install with no data surgery.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, INTENTIONALLY_EMPTY_SKU } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };

interface ItemView {
  order_item_id: string;
  sku: string;
  price: number;
  status: string;
  delivery: { code: string; supplier: string } | null;
  refund: { amount: number; reason: string } | null;
}

interface OrderView {
  status: string;
  amount: number;
  items: ItemView[];
  money: { paid: number; delivered: number; refunded: number; unresolved: number };
}

/**
 * Pushes the order to a final state.
 *
 * Delivery is retried by the recovery sweep rather than by settlement, on
 * purpose: an immediate retry would be a busy loop against a supplier that just
 * failed. So the budget is spent one sweep at a time, and the test drives those
 * sweeps rather than sleeping through them. STUCK_ORDER_AFTER_MS is 0 in the
 * harness, so every sweep is eligible immediately.
 */
async function runToCompletion(harness: Harness, rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await harness.drain();
    await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
    await harness.drain();
  }
}

describe('stage 2, task 1: a basket where one line cannot be delivered', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('keeps what was delivered, refunds what was not, and the money adds up', async () => {
    const skus = ['KEY-CS2-PRIME', 'STEAM-TOPUP-500', INTENTIONALLY_EMPTY_SKU];
    const { orderId, amount, itemIds } = await harness.createBasket(skus);

    assert.equal(itemIds.length, 3, 'each product must become its own line');

    const webhook = await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_partial_${orderId}` }),
    });
    assert.equal(webhook.statusCode, 200, 'one line being unfulfillable must not fail the payment');

    await runToCompletion(harness);

    const order = (await harness.getOrder(orderId)) as unknown as OrderView;

    // The honest outcome. Not "delivered", which would lie about the third line,
    // and not "failed", which would lie about the first two.
    assert.equal(order.status, 'partially_delivered');

    const delivered = order.items.filter((item) => item.status === 'delivered');
    const refunded = order.items.filter((item) => item.status === 'refunded');
    assert.equal(delivered.length, 2, 'both available products must have been delivered');
    assert.equal(refunded.length, 1);
    assert.equal(refunded[0]?.sku, INTENTIONALLY_EMPTY_SKU, 'only the empty SKU may be refunded');

    // "Что смогли выдать, то остаётся у покупателя." The codes are still there.
    for (const item of delivered) {
      assert.ok(item.delivery?.code, `line ${item.sku} must still hold its code`);
      assert.equal(item.refund, null, 'a delivered line must never also be refunded');
    }

    // "За что не смогли, деньги возвращаются."
    assert.equal(refunded[0]?.refund?.amount, refunded[0]?.price);
    assert.equal(refunded[0]?.refund?.reason, 'out_of_stock');
    assert.equal(refunded[0]?.delivery, null);

    // "По деньгам всегда сходится: оплачено равно выдано плюс возвращено."
    assert.equal(order.money.paid, amount);
    assert.equal(order.money.unresolved, 0, 'a finished order has nothing in flight');
    assert.equal(
      order.money.delivered + order.money.refunded,
      order.money.paid,
      'paid must equal delivered plus refunded',
    );
  });

  it('reports the same arithmetic from the admin surface, computed independently', async () => {
    const money = await harness.api.inject({ url: '/admin/money', headers: ADMIN });
    assert.equal(money.statusCode, 200, 'every paid order must add up');

    const body = money.json() as {
      balanced: boolean;
      totals: { paid: number; delivered: number; refunded: number; unresolved: number };
      mismatched: unknown[];
    };
    assert.equal(body.balanced, true);
    assert.deepEqual(body.mismatched, []);
    assert.equal(
      body.totals.delivered + body.totals.refunded + body.totals.unresolved,
      body.totals.paid,
      'the same identity must hold across every order at once',
    );

    // And the journal, which is a different set of tables reaching the same
    // conclusion: net revenue is the value of what was actually handed over.
    const ledger = await harness.api.inject({ url: '/admin/ledger/balance', headers: ADMIN });
    const accounts = new Map(
      (ledger.json() as { by_account: Array<{ account: string; signedMinor: number }> }).by_account.map(
        (row) => [row.account, Number(row.signedMinor)],
      ),
    );
    assert.equal((ledger.json() as { balanced: boolean }).balanced, true);
    assert.equal(
      -((accounts.get('revenue') ?? 0) + (accounts.get('refund') ?? 0)),
      body.totals.delivered,
      'net revenue must equal the value of the delivered lines',
    );
    // Cash still held at the provider is what was paid minus what went back.
    assert.equal(accounts.get('psp_cash') ?? 0, body.totals.paid - body.totals.refunded);
  });

  it('is idempotent: replaying every job changes neither the goods nor the money', async () => {
    const snapshot = async () =>
      harness.pool.query<{ deliveries: number; refunds: number; entries: number }>(
        `SELECT (SELECT count(*) FROM deliveries)::int AS deliveries,
                (SELECT count(*) FROM refunds)::int AS refunds,
                (SELECT count(*) FROM ledger_entries)::int AS entries`,
      );

    const first = (await snapshot()).rows[0];

    // Re-drive everything: redeliver, settle, recover, drain. At-least-once is
    // the only guarantee the queue offers, so running it all again is a normal
    // occurrence and must be a no-op.
    const orders = await harness.pool.query<{ id: string }>('SELECT id FROM orders');
    for (const { id } of orders.rows) {
      await harness.api.inject({ method: 'POST', url: `/admin/orders/${id}/redeliver`, headers: ADMIN });
      await harness.api.inject({ method: 'POST', url: `/admin/orders/${id}/settle`, headers: ADMIN });
    }
    await runToCompletion(harness, 3);

    const second = (await snapshot()).rows[0];
    assert.deepEqual(second, first, 'a full replay must not create extra deliveries, refunds or entries');
  });
});
