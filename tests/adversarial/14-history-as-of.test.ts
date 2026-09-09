/**
 * Stage two, task 4: "Восстановление картины на любой момент".
 *
 *   1) по запросу на дату видно, в каком состоянии были заказ и деньги;
 *   2) история только дополняется, задним числом ничего не переписывается;
 *   3) итоги за период считаются из этой истории и сходятся.
 *
 * The second requirement is the one usually claimed and rarely enforced, so it
 * is tested the only way that means anything: by trying to rewrite history and
 * requiring the database to refuse.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, INTENTIONALLY_EMPTY_SKU } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };

interface Snapshot {
  status: string | null;
  amount: number;
  money: { paid: number; delivered: number; refunded: number; unresolved: number };
  items: Array<{ sku: string; status: string; has_code: boolean }>;
  events_applied: number;
  events_total: number;
}

const asOf = (harness: Harness, orderId: string, ts: Date) =>
  harness.api
    .inject({ url: `/admin/orders/${orderId}/at?ts=${encodeURIComponent(ts.toISOString())}`, headers: ADMIN })
    .then((response) => ({ statusCode: response.statusCode, body: response.json() as Snapshot }));

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('stage 2, task 4: reconstructing the past', () => {
  let harness: Harness;
  let orderId: string;
  let amount: number;
  const t: Record<string, Date> = {};

  before(async () => {
    harness = await startHarness();

    // A basket that ends partially delivered, so the reconstruction has to
    // distinguish three different moments with three different answers.
    t.beforeAnything = new Date();
    await pause();

    const created = await harness.createBasket(['KEY-CS2-PRIME', INTENTIONALLY_EMPTY_SKU]);
    orderId = created.orderId;
    amount = created.amount;
    await pause();
    t.afterCreated = new Date();
    await pause();

    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_hist_${orderId}` }),
    });
    await harness.drain();
    await pause();
    t.afterPaidAndDelivering = new Date();
    await pause();

    // Run it out to the refund of the unfulfillable line.
    for (let round = 0; round < 6; round += 1) {
      await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
      await harness.drain();
    }
    await pause();
    t.afterSettled = new Date();
  });

  after(async () => {
    await harness.stop();
  });

  it('says the order did not exist before it existed', async () => {
    const { body } = await asOf(harness, orderId, t.beforeAnything!);
    assert.equal(body.status, null, 'an order has no state before it was created');
    assert.equal(body.events_applied, 0);
    assert.ok(body.events_total > 0, 'the events exist, they were simply not visible yet at that moment');
  });

  it('reconstructs the moment after creation, before any money arrived', async () => {
    const { body } = await asOf(harness, orderId, t.afterCreated!);
    assert.equal(body.status, 'created');
    assert.equal(body.amount, amount, 'the basket total as it was, not as the catalog is today');
    assert.equal(body.money.paid, 0, 'nothing had been paid yet');
    assert.equal(body.money.delivered, 0);
    assert.equal(body.items.length, 2);
    assert.ok(body.items.every((item) => !item.has_code));
  });

  it('reconstructs the moment when one line was delivered and the other was not', async () => {
    const { body } = await asOf(harness, orderId, t.afterPaidAndDelivering!);
    assert.equal(body.money.paid, amount, 'the money had arrived by then');

    const delivered = body.items.filter((item) => item.status === 'delivered');
    assert.equal(delivered.length, 1, 'exactly one line had a code at that moment');
    assert.equal(delivered[0]?.sku, 'KEY-CS2-PRIME');

    // The money invariant, evaluated in the past. At that instant part of what
    // the customer paid was neither delivered nor yet refunded, and the
    // reconstruction has to say so rather than smooth it over.
    assert.equal(
      body.money.delivered + body.money.refunded + body.money.unresolved,
      body.money.paid,
      'paid = delivered + refunded + unresolved must hold at every point in the history',
    );
    assert.ok(body.money.unresolved > 0, 'the second line was still in flight');
  });

  it('reconstructs the finished order, with the refund visible', async () => {
    const { body } = await asOf(harness, orderId, t.afterSettled!);
    assert.equal(body.status, 'partially_delivered');
    assert.equal(body.money.unresolved, 0, 'nothing is in flight once the order is finished');
    assert.equal(
      body.money.delivered + body.money.refunded,
      body.money.paid,
      'оплачено = выдано + возвращено, read back out of the history',
    );

    const refunded = body.items.filter((item) => item.status === 'refunded');
    assert.equal(refunded.length, 1);
    assert.equal(refunded[0]?.sku, INTENTIONALLY_EMPTY_SKU);
  });

  it('gives the same answer for a past moment however much has happened since', async () => {
    // The point of a history is that it does not move. Asking twice, with more
    // facts recorded in between, must produce the same past.
    const first = await asOf(harness, orderId, t.afterCreated!);

    await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
    await harness.drain();

    const second = await asOf(harness, orderId, t.afterCreated!);
    assert.deepEqual(second.body.money, first.body.money, 'the past must not change when the present does');
    assert.equal(second.body.status, first.body.status);
  });

  it('refuses to let history be rewritten, and says so', async () => {
    // Requirement 2, enforced by the database rather than by convention. A table
    // nobody happens to UPDATE is not append-only; it is a table that has been
    // lucky.
    await assert.rejects(
      harness.pool.query(`UPDATE order_events SET type = 'tampered' WHERE order_id = $1`, [orderId]),
      (error: Error & { code?: string }) => {
        assert.match(error.message, /append-only/);
        return true;
      },
      'an UPDATE against the history must be refused',
    );

    await assert.rejects(
      harness.pool.query(`DELETE FROM order_events WHERE order_id = $1`, [orderId]),
      /append-only/,
      'a DELETE against the history must be refused',
    );

    // The money journal too, and this is the one that matters most: every claim
    // in this project that the money adds up rests on these rows never having
    // been quietly adjusted.
    await assert.rejects(
      harness.pool.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE order_id = $1`, [orderId]),
      /append-only/,
      'the ledger must be append-only too',
    );
    await assert.rejects(
      harness.pool.query(`DELETE FROM ledger_entries WHERE order_id = $1`, [orderId]),
      /append-only/,
    );

    // And the history survived the attempts intact.
    const after = await asOf(harness, orderId, t.afterSettled!);
    assert.equal(after.body.status, 'partially_delivered');
  });

  it('adds up over a period, from the journal', async () => {
    const from = new Date(t.beforeAnything!.getTime() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const response = await harness.api.inject({
      url: `/admin/reports/period?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 200, `the period must balance: ${response.body}`);

    const body = response.json() as {
      balanced: boolean;
      captured: number;
      refunded: number;
      net_revenue: number;
      cash_movement: number;
      orders_paid: number;
      items_delivered: number;
      items_refunded: number;
    };

    assert.equal(body.balanced, true);
    assert.equal(body.captured, amount, 'one paid order in the window');
    assert.ok(body.refunded > 0, 'and one refunded line');
    // Three independent account sums telling one story: cash still held is what
    // was captured minus what went back.
    assert.equal(body.cash_movement, body.captured - body.refunded);
    assert.equal(body.net_revenue, body.captured - body.refunded);
    assert.equal(body.orders_paid, 1);
    assert.equal(body.items_delivered, 1);
    assert.equal(body.items_refunded, 1);
  });

  it('reports nothing for a period in which nothing happened', async () => {
    const from = new Date(t.beforeAnything!.getTime() - 7_200_000).toISOString();
    const to = new Date(t.beforeAnything!.getTime() - 3_600_000).toISOString();

    const response = await harness.api.inject({
      url: `/admin/reports/period?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 200);

    const body = response.json() as { captured: number; refunded: number; orders_paid: number; balanced: boolean };
    assert.deepEqual(
      { captured: body.captured, refunded: body.refunded, orders_paid: body.orders_paid },
      { captured: 0, refunded: 0, orders_paid: 0 },
      'an empty period is zero, not an error and not a projection of the present',
    );
    assert.equal(body.balanced, true);
  });
});
