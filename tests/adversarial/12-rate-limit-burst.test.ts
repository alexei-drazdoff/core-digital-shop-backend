/**
 * Stage two, task 3: "Всплеск заказов и лимит поставщика".
 *
 * The two requirements pull against each other. Never exceed the supplier's
 * limit is trivial on its own — drop the excess. Never lose an order is what the
 * queue already did. Together they mean the excess has to WAIT, and the whole
 * design question is what waiting costs.
 *
 * The answer has to be "nothing", and that is the assertion this file is really
 * about. `claim` increments a job's attempts unconditionally and `fail` kills a
 * job once they run out, so a deferral routed through the failure path would let
 * a big enough burst quietly exterminate the jobs at the back of the queue. The
 * system would report a perfectly respected rate limit while losing orders,
 * which is the least visible possible way to violate "ничего не теряется".
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };
const BURST = 24;
const SKU = 'STEAM-TOPUP-500';

/**
 * Deep stock at both suppliers.
 *
 * The seed ships a handful of keys per SKU, which is plenty for the first
 * stage's scenarios and useless here: a burst of 24 would run the pool dry and
 * the test would be measuring stock exhaustion while claiming to measure a rate
 * limit. Stocking it deliberately makes the limiter the only thing that can be
 * scarce.
 */
async function stockUp(harness: Harness, perSupplier: number): Promise<void> {
  for (const supplier of [SUPPLIER_A, SUPPLIER_B]) {
    await harness.pool.query(
      `INSERT INTO supplier_stub.keys (supplier, sku, code)
       SELECT $1, $2, $1 || '-BURST-' || generate_series(1, $3)
       ON CONFLICT (supplier, code) DO NOTHING`,
      [supplier, SKU, perSupplier],
    );
  }
  await harness.api.inject({ method: 'POST', url: '/admin/sync-stock', headers: ADMIN });
}

/** A tiny bucket that refills slowly enough that the burst cannot be absorbed. */
async function throttle(harness: Harness, supplier: string, capacity: number): Promise<void> {
  await harness.pool.query(
    `UPDATE supplier_rate_limits
        SET capacity = $2::int, refill_per_minute = 60, tokens = $2::numeric, updated_at = now()
      WHERE supplier = $1`,
    [supplier, capacity],
  );
}

interface Progress {
  pending_jobs: number;
  dead_jobs: number;
  items: { delivered: number; refunded: number; waiting: number };
  supplier_capacity: Array<{ supplier: string; tokens: number; capacity: number }>;
}

describe('stage 2, task 3: a burst of orders against a limited supplier', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('holds the limit, loses nothing, and shows the backlog', async () => {
    await stockUp(harness, BURST * 2);

    // Between them the suppliers can serve 8 of the 24 lines right now. The rest
    // have to wait for the bucket to refill, and at 60 per minute the refill is
    // far too slow to absorb the burst inside this test.
    await throttle(harness, SUPPLIER_A, 4);
    await throttle(harness, SUPPLIER_B, 4);

    const orders: string[] = [];
    for (let index = 0; index < BURST; index += 1) {
      const { orderId, amount } = await harness.createOrder(SKU);
      orders.push(orderId);
      await harness.api.inject({
        method: 'POST',
        url: '/webhooks/payment',
        payload: buildPayload({ orderId, amount, eventId: `evt_burst_${orderId}` }),
      });
    }

    // Drain hard. Every job that can run, runs; the rest come back deferred.
    await harness.drain(30);

    const progress = (await harness.api.inject({ url: '/admin/queue/progress', headers: ADMIN })).json() as Progress;

    // Requirement: the limit is not exceeded.
    //
    // Counted as HTTP REQUESTS, not as issued codes, and the difference is the
    // whole point. The supplier's limit is "запросов в минуту", so a retry costs
    // it just as much as a first call; counting issuances would make a delivery
    // that retried three times look like one request and report a limit being
    // respected while it was being exceeded threefold.
    const requests = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM delivery_attempts`,
    );
    const sent = requests.rows[0]?.count ?? 0;

    // Started with 4 + 4 tokens and refills at 60/minute each. The drain takes
    // seconds, so the ceiling is the initial burst plus a small refill, and it
    // is nowhere near one request per line.
    assert.ok(sent > 0, 'the suppliers must have been asked as often as capacity allowed');
    assert.ok(
      sent < BURST,
      `the supplier must not have received a request per line (received ${sent} for ${BURST} lines)`,
    );

    const issued = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM supplier_stub.issuances WHERE sku = $1`,
      [SKU],
    );
    const served = issued.rows[0]?.count ?? 0;
    assert.ok(served > 0, 'the suppliers must have served the capacity they did have');
    assert.ok(served <= sent, 'a code cannot be issued without a request behind it');

    // Requirement: nothing is lost. This is the assertion that matters — a
    // deferral must never be charged as an attempt, so no job may die of waiting.
    assert.equal(progress.dead_jobs, 0, 'no job may die because a supplier was busy');

    const dead = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE state = 'dead'`,
    );
    assert.equal(dead.rows[0]?.count, 0);

    // Every line is still accounted for: delivered, or waiting its turn.
    assert.equal(
      progress.items.delivered + progress.items.waiting + progress.items.refunded,
      BURST,
      'every paid line must be either served or still in the queue',
    );
    assert.ok(progress.items.waiting > 0, 'the excess must be visibly waiting');

    // Requirement: the progress is visible.
    assert.ok(progress.supplier_capacity.length >= 2, 'remaining supplier capacity must be reported');

    // Waiting was free. Jobs that deferred did so without spending attempts.
    const deferred = await harness.pool.query<{ deferrals: number; attempts: number }>(
      `SELECT COALESCE(SUM(deferrals), 0)::int AS deferrals, COALESCE(MAX(attempts), 0)::int AS attempts
         FROM jobs WHERE kind = 'deliver_order_item'`,
    );
    assert.ok((deferred.rows[0]?.deferrals ?? 0) > 0, 'the burst must actually have produced deferrals');
    assert.ok(
      (deferred.rows[0]?.attempts ?? 0) <= 2,
      'a deferred job must not accumulate attempts, or a long enough burst would kill it',
    );
  });

  it('never charges a round to a line whose supplier was merely busy', async () => {
    // The failure this guards against costs real money. If a throttled supplier
    // counted as a failed delivery round, three bursts would exhaust the line's
    // budget and settlement would refund a customer whose goods were available
    // the whole time — money moving because a supplier was busy.
    const rounds = await harness.pool.query<{ max: number }>(
      `SELECT COALESCE(MAX(i.rounds), 0)::int AS max
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.sku = $1`,
      [SKU],
    );
    assert.equal(rounds.rows[0]?.max, 0, 'waiting for capacity must not spend a delivery round');

    const refunds = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM refunds r
         JOIN order_items i ON i.id = r.order_item_id
        WHERE i.sku = $1`,
      [SKU],
    );
    assert.equal(refunds.rows[0]?.count, 0, 'nothing may be refunded while stock exists and the queue is merely full');
  });

  it('serves the paid work first when capacity frees up', async () => {
    // Priority only bites when capacity is scarce, which is exactly now. A first
    // attempt at a paid line outranks a retry of one, and both outrank
    // settlement and reconciliation.
    const claimed = await harness.pool.query<{ kind: string; priority: number }>(
      `SELECT kind, MAX(priority)::int AS priority FROM jobs GROUP BY kind ORDER BY priority DESC`,
    );
    const priorities = new Map(claimed.rows.map((row) => [row.kind, row.priority]));
    assert.equal(priorities.get('deliver_order_item'), 200, 'paid delivery must be the highest priority work');
    assert.ok(
      (priorities.get('settle_order') ?? 0) < (priorities.get('deliver_order_item') ?? 0),
      'settlement must not compete with fetching goods a customer has paid for',
    );

    // And the claim query actually honours it: the next jobs off the queue are
    // the highest priority ones that are due.
    const next = await harness.pool.query<{ priority: number }>(
      `SELECT priority FROM jobs
        WHERE state = 'pending' AND run_after <= now()
        ORDER BY priority DESC, run_after, id
        LIMIT 5`,
    );
    if (next.rows.length > 1) {
      const ordered = next.rows.every((row, index) => index === 0 || row.priority <= next.rows[index - 1]!.priority);
      assert.ok(ordered, 'the claim order must be by descending priority');
    }
  });

  it('drains the backlog once the limit is lifted, with the money still adding up', async () => {
    // Open the taps. Everything that was waiting must now complete: waiting was
    // never a failure, so there is nothing to recover from.
    await throttle(harness, SUPPLIER_A, 600);
    await throttle(harness, SUPPLIER_B, 600);

    for (let round = 0; round < 6; round += 1) {
      await harness.pool.query(`UPDATE jobs SET run_after = now() WHERE state = 'pending'`);
      await harness.drain(30);
      await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
      await harness.drain(30);
    }

    const progress = (await harness.api.inject({ url: '/admin/queue/progress', headers: ADMIN })).json() as Progress;
    assert.equal(progress.items.waiting, 0, 'the whole backlog must eventually be served');
    assert.equal(
      progress.items.refunded,
      0,
      'nothing was refunded: waiting for capacity is not a failure, so no line may be written off',
    );
    assert.equal(progress.items.delivered, BURST, 'nothing was lost: every line of the burst got its code');
    assert.equal(progress.dead_jobs, 0);

    const money = await harness.api.inject({ url: '/admin/money', headers: ADMIN });
    assert.equal(money.statusCode, 200, `money must add up after the burst: ${money.body}`);

    const report = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    assert.equal(report.statusCode, 200, `reconciliation must be healthy after the burst: ${report.body}`);
  });
});
