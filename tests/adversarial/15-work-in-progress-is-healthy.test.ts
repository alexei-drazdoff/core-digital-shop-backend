/**
 * Работа в процессе — не расхождение.
 *
 * Every other file in this suite drains to quiescence before asserting, which
 * makes them structurally blind to this: they only ever see a system with
 * nothing in flight. So the one property that only holds MID-FLIGHT gets its own
 * file, and its own harness with a realistic staleness deadline — the shared one
 * runs with `STUCK_ORDER_AFTER_MS=0`, which means "consider everything stuck at
 * once" and makes the question unaskable.
 *
 * The failure being guarded against is subtle and expensive. `beginAttempt`
 * writes `in_flight` BEFORE the supplier call — deliberately, because a row
 * saying "a side effect may exist" is the only evidence a crashed delivery
 * leaves behind. So such a row exists for the whole duration of every perfectly
 * normal supplier conversation. A reconciliation report that listed them
 * unfiltered would answer 409 whenever the system was doing its job, and both
 * the README and docs/ANSWERS.md tell a reviewer that 200 means healthy and that
 * the endpoint can be wired to a monitor without parsing the body.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };

describe('work in progress does not read as a discrepancy', () => {
  let harness: Harness;

  before(async () => {
    // A production-shaped deadline: a supplier conversation that started a
    // moment ago is not yet a discrepancy, one that started five minutes ago is.
    harness = await startHarness({ STUCK_ORDER_AFTER_MS: '300000' });
  });
  after(async () => {
    await harness.stop();
  });

  it('answers healthy while a supplier call is still in flight', async () => {
    // Both suppliers hang, so the delivery is genuinely mid-conversation while
    // the report is taken: `supplier_requests` holds live `in_flight` rows and
    // `order_items` holds a paid, undelivered line.
    for (const supplier of [SUPPLIER_A, SUPPLIER_B]) {
      await harness.chaos(supplier, {
        forced_outcome: 'timeout',
        hang_ms: 60_000,
        issue_before_hang: false,
        hang_before_lookup: true,
      });
    }

    const { orderId, amount } = await harness.createOrder('KEY-CS2-PRIME');
    await harness.api.inject({
      method: 'POST',
      url: '/webhooks/payment',
      payload: buildPayload({ orderId, amount, eventId: `evt_wip_${orderId}` }),
    });

    // Deliberately NOT awaited: the assertion has to happen while the delivery
    // is still talking to the suppliers, which is the whole point.
    const draining = harness.drain(20);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const inFlight = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM supplier_requests WHERE state IN ('in_flight', 'unknown')`,
    );
    assert.ok(
      (inFlight.rows[0]?.count ?? 0) > 0,
      'the test needs a live supplier conversation, otherwise it proves nothing',
    );

    const report = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    const body = report.json() as { healthy: boolean; unresolved_supplier_requests: unknown[] };

    assert.deepEqual(
      body.unresolved_supplier_requests,
      [],
      'a conversation that started moments ago is work in progress, not a discrepancy',
    );
    assert.equal(body.healthy, true);
    assert.equal(report.statusCode, 200, `a busy system must not report unhealthy: ${report.body}`);

    await draining;
    for (const supplier of [SUPPLIER_A, SUPPLIER_B]) {
      await harness.chaos(supplier, { forced_outcome: null, hang_before_lookup: false });
    }
  });

  it('still reports a claim that has been unresolved past the deadline', async () => {
    // The other half: filtering by the deadline must not blind the report to the
    // rows it exists to catch. A claim left behind by a crashed worker ages past
    // the deadline and has to surface.
    await harness.pool.query(
      `UPDATE supplier_requests
          SET state = 'unknown', last_sent_at = now() - interval '1 hour'
        WHERE state IN ('in_flight', 'unknown', 'failed_definitive')`,
    );

    const report = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    const body = report.json() as { healthy: boolean; unresolved_supplier_requests: unknown[] };

    assert.ok(
      body.unresolved_supplier_requests.length > 0,
      'a stale claim must still be reported, or the deadline filter has blinded the report',
    );
    assert.equal(body.healthy, false);
    assert.equal(report.statusCode, 409);
  });
});
