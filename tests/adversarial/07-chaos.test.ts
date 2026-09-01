/**
 * Randomised chaos run.
 *
 * The six scripted criteria each prove one property in isolation. This one runs
 * many orders through suppliers that fail and hang at random, then asserts the
 * invariants that must hold no matter which way the dice fell. Scripted tests
 * prove the cases we thought of; this one guards the ones we did not.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ORDERS = 40;
const SKUS = ['STEAM-TOPUP-500', 'KEY-GTA5', 'SUB-DISCORD-1M', 'GIFT-XBOX-1500'];

describe('chaos: invariants hold under random supplier failures', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness({ SUPPLIER_MAX_ATTEMPTS: '2' });
  });
  after(async () => {
    await harness.stop();
  });

  it('never double delivers, never loses money, and leaves nothing in a dead end', async () => {
    // Stock up first. The seeded pool holds only a handful of keys per SKU, and
    // this test is about supplier misbehaviour, not inventory limits: without
    // this the run would end in out_of_stock and prove nothing about chaos.
    for (const sku of SKUS) {
      for (const supplier of [SUPPLIER_A, SUPPLIER_B]) {
        const response = await harness.api.inject({
          method: 'POST',
          url: '/admin/inventory/replenish',
          headers: { authorization: 'Bearer test-admin-token' },
          payload: { sku, supplier, count: ORDERS },
        });
        assert.equal(response.statusCode, 200);
      }
    }

    // Both suppliers misbehave, and A is the worse of the two. Hangs are short
    // so the run stays quick while still tripping the real client timeout.
    await harness.chaos(SUPPLIER_A, { error_rate: 0.3, timeout_rate: 0.3, hang_ms: 600, issue_before_hang: true });
    await harness.chaos(SUPPLIER_B, { error_rate: 0.2, timeout_rate: 0.1, hang_ms: 600, issue_before_hang: true });

    const orders = await Promise.all(
      Array.from({ length: ORDERS }, (_, index) => harness.createOrder(SKUS[index % SKUS.length] as string)),
    );

    // Every order paid at once, and a third of them paid twice, so duplicate
    // webhooks are part of the storm rather than a separate test.
    await Promise.all(
      orders.flatMap(({ orderId, amount }, index) => {
        const payload = buildPayload({ orderId, amount, eventId: `evt_chaos_${index}` });
        const sends = [harness.api.inject({ method: 'POST', url: '/webhooks/payment', payload })];
        if (index % 3 === 0) sends.push(harness.api.inject({ method: 'POST', url: '/webhooks/payment', payload }));
        return sends;
      }),
    );

    await harness.drain(60);

    // Suppliers recover, and the system is given the chance to finish what it started.
    await harness.chaos(SUPPLIER_A, { error_rate: 0, timeout_rate: 0 });
    await harness.chaos(SUPPLIER_B, { error_rate: 0, timeout_rate: 0 });
    for (let round = 0; round < 6; round += 1) {
      await harness.container.useCases.recoverStuckOrders.execute();
      await harness.pool.query(`UPDATE jobs SET run_after = now() WHERE state = 'pending'`);
      await harness.drain(60);
    }

    // Invariant 1: a delivered order has exactly one code. Enforced by the
    // unique constraint, asserted here to prove nothing routes around it.
    const doubled = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT order_id FROM deliveries GROUP BY order_id HAVING count(*) > 1
       ) AS duplicated`,
    );
    assert.equal(doubled.rows[0]?.count, 0, 'no order may have two deliveries');

    // Invariant 2: no code was handed to two different orders.
    const sharedCodes = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT code FROM deliveries GROUP BY code HAVING count(*) > 1
       ) AS shared`,
    );
    assert.equal(sharedCodes.rows[0]?.count, 0, 'a code may never be sold twice');

    // Invariant 3: the money journal balances, orphaned issuances included.
    const imbalance = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT group_id FROM ledger_entries GROUP BY group_id HAVING sum(signed_minor) <> 0
       ) AS unbalanced`,
    );
    assert.equal(imbalance.rows[0]?.count, 0, 'every ledger group must net to zero');

    // Invariant 4: goods never leave without a payment behind them.
    const freeGoods = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM deliveries d
        WHERE NOT EXISTS (
          SELECT 1 FROM ledger_entries le
           WHERE le.order_id = d.order_id AND le.account = 'psp_cash' AND le.direction = 'debit')`,
    );
    assert.equal(freeGoods.rows[0]?.count, 0, 'nothing may be delivered without a captured payment');

    // Invariant 5: every paid order reached a final state, or a recoverable one
    // that the sweep will keep working on. Nothing may be stranded mid-flight.
    const stranded = await harness.pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM orders
        WHERE status IN ('paid', 'delivering') GROUP BY status`,
    );
    assert.equal(stranded.rowCount, 0, `orders stranded mid delivery: ${JSON.stringify(stranded.rows)}`);

    // Invariant 6: with healthy suppliers and enough stock, everything sold.
    const byStatus = await harness.pool.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM orders GROUP BY status ORDER BY status',
    );
    const delivered = byStatus.rows.find((row) => row.status === 'delivered')?.count ?? 0;
    assert.equal(delivered, ORDERS, `every order should end delivered, got ${JSON.stringify(byStatus.rows)}`);

    // Invariant 7: each order consumed exactly one supplier code, or the extras
    // were recorded as orphans. Stock is never lost silently.
    const accounted = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM supplier_stub.issuances i
    LEFT JOIN deliveries d ON d.code = i.code
    LEFT JOIN orphan_issuances o ON o.code = i.code
        WHERE d.code IS NULL AND o.code IS NULL`,
    );
    assert.equal(accounted.rows[0]?.count, 0, 'every issued code must be either sold or written off');
  });
});
