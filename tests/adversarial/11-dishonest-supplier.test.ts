/**
 * Stage two, task 2: "Поставщик, которому нельзя доверять".
 *
 * The first stage's supplier was unreliable but honest, and every defence built
 * for it protects against an ANSWER GOING MISSING. This one lies: it hands back
 * a code it already gave somebody else, or a code from another product's pool,
 * and both arrive looking exactly like success. No retry fixes that, because the
 * answer is not missing — it is wrong.
 *
 * The requirements being checked:
 *
 *   1) один и тот же код никогда не попадает в два заказа, даже если поставщик
 *      прислал дубль;
 *   2) покупатель по заказу получает ровно один рабочий код;
 *   3) если поставщик ответил ошибкой, но код всё же выдал, повтор не приводит
 *      ко второй выдаче;
 *   4) расхождения обнаруживаются и разбираются автоматически.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, SUPPLIER_A, SUPPLIER_B } from '../helpers/harness.js';
import { buildPayload } from '../../src/stubs/payment-simulator/simulator.js';

const ADMIN = { authorization: 'Bearer test-admin-token' };

interface OrderView {
  status: string;
  items: Array<{
    order_item_id: string;
    sku: string;
    status: string;
    delivery: { code: string; supplier: string } | null;
  }>;
  money: { paid: number; delivered: number; refunded: number; unresolved: number };
  supplier_requests: Array<{ supplier: string; request_id: string; epoch: number; state: string }>;
}

async function pay(harness: Harness, orderId: string, amount: number, tag: string): Promise<void> {
  const response = await harness.api.inject({
    method: 'POST',
    url: '/webhooks/payment',
    payload: buildPayload({ orderId, amount, eventId: `evt_${tag}_${orderId}` }),
  });
  assert.equal(response.statusCode, 200);
}

describe('stage 2, task 2: a supplier whose answers cannot be trusted', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('refuses a code that was already issued to another order, and still serves the customer', async () => {
    // First order runs honestly, so there is a real code in circulation for the
    // supplier to try to hand out a second time.
    const first = await harness.createOrder('KEY-CS2-PRIME');
    await pay(harness, first.orderId, first.amount, 'honest');
    await harness.drain();

    const firstView = (await harness.getOrder(first.orderId)) as unknown as OrderView;
    assert.equal(firstView.status, 'delivered');
    const stolenCode = firstView.items[0]?.delivery?.code;
    assert.ok(stolenCode, 'the first order must have a code for the second one to be offered');

    // Now supplier A starts handing back somebody else's code. B stays honest,
    // so the customer can still be served — which is the point: detecting the
    // lie must not cost the paying customer their goods.
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'duplicate_code' });

    const second = await harness.createOrder('KEY-CS2-PRIME');
    await pay(harness, second.orderId, second.amount, 'dup');
    await harness.drain();

    const secondView = (await harness.getOrder(second.orderId)) as unknown as OrderView;

    // Requirement 2: exactly one working code.
    assert.equal(secondView.status, 'delivered');
    const servedCode = secondView.items[0]?.delivery?.code;
    assert.ok(servedCode);

    // Requirement 1: never the same code twice.
    assert.notEqual(servedCode, stolenCode, 'the duplicated code must not have been handed over');
    assert.equal(secondView.items[0]?.delivery?.supplier, SUPPLIER_B, 'the honest fallback must have served it');

    // The duplicate is still registered to the FIRST order, which is what makes
    // "один код не уйдёт двум покупателям" true rather than hopeful.
    const owner = await harness.pool.query<{ order_id: string; disposition: string }>(
      'SELECT order_id, disposition FROM issued_codes WHERE code = $1',
      [stolenCode],
    );
    assert.equal(owner.rows[0]?.order_id, first.orderId);
    assert.equal(owner.rows[0]?.disposition, 'delivered');

    // And the bad answer earned a new request epoch rather than a plain retry,
    // because re-asking the same request id would fetch the same lie forever.
    const atA = secondView.supplier_requests.filter((request) => request.supplier === SUPPLIER_A);
    assert.ok(atA.length >= 2, 'a rejected answer must open a new epoch');
    assert.deepEqual(
      [...new Set(atA.map((request) => request.epoch))].sort(),
      [1, 2],
      'the epochs must be distinct, so the request ids are genuinely different questions',
    );

    const rejected = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM delivery_attempts
        WHERE order_item_id = $1 AND outcome = 'rejected'`,
      [secondView.items[0]?.order_item_id],
    );
    assert.ok((rejected.rows[0]?.count ?? 0) >= 1, 'the rejection must be recorded as its own outcome');

    await harness.chaos(SUPPLIER_A, { forced_outcome: null });
  });

  it('refuses a code from another product and quarantines it', async () => {
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'foreign_code' });

    const { orderId, amount } = await harness.createOrder('KEY-GTA5');
    await pay(harness, orderId, amount, 'foreign');
    await harness.drain();

    const view = (await harness.getOrder(orderId)) as unknown as OrderView;
    assert.equal(view.status, 'delivered', 'the customer must still be served by the honest supplier');
    assert.equal(view.items[0]?.delivery?.supplier, SUPPLIER_B);

    // The offered code was for a different SKU. It is recorded so it can never
    // be handed to anybody, including to whoever legitimately buys that product.
    const quarantined = await harness.api.inject({ url: '/admin/quarantined-codes', headers: ADMIN });
    const items = (quarantined.json() as { items: Array<{ reason: string; supplier: string }> }).items;
    assert.ok(items.length > 0, 'the foreign code must be quarantined');
    assert.equal(items[0]?.reason, 'sku_mismatch');
    assert.equal(items[0]?.supplier, SUPPLIER_A);

    // Quarantined codes are visible in the report, but a misbehaving supplier is
    // not this system being unhealthy: it detected and handled the lie.
    const report = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    const body = report.json() as { quarantined_codes: unknown[]; healthy: boolean };
    assert.ok(body.quarantined_codes.length > 0, 'the discrepancy must be visible');

    await harness.chaos(SUPPLIER_A, { forced_outcome: null });
  });

  it('does not buy a second code when the supplier errors after having issued one', async () => {
    // Requirement 3. This is NOT the timeout trap: the supplier answers, and it
    // answers with a definitive failure, which is exactly the answer that tempts
    // a caller into failing over immediately. The key is already gone.
    await harness.chaos(SUPPLIER_A, { forced_outcome: 'error_after_issue' });

    const { orderId, amount } = await harness.createOrder('GIFT-PSN-1000');
    const itemId = await harness.singleItemId(orderId);
    await pay(harness, orderId, amount, 'errissue');
    await harness.drain();

    // Supplier A consumed exactly one key, however many times it was asked.
    // Reusing the request id across the retries is what holds this line.
    assert.equal(
      await harness.issuanceCount(SUPPLIER_A, itemId),
      1,
      'the retries must all have asked about the same request, so only one key was consumed',
    );

    // Let A behave again and run the reconciliation the delivery path scheduled.
    await harness.chaos(SUPPLIER_A, { forced_outcome: null });
    await harness.api.inject({ method: 'POST', url: '/admin/reconcile-suppliers', headers: ADMIN });
    await harness.drain();
    await harness.api.inject({ method: 'POST', url: '/admin/recover', headers: ADMIN });
    await harness.drain();

    const view = (await harness.getOrder(orderId)) as unknown as OrderView;
    assert.equal(view.status, 'delivered');
    assert.equal(view.money.delivered + view.money.refunded, view.money.paid);

    // Still exactly one key at A, and the customer holds exactly one code.
    assert.equal(await harness.issuanceCount(SUPPLIER_A, itemId), 1);
    const deliveries = await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE order_item_id = $1',
      [itemId],
    );
    assert.equal(deliveries.rows[0]?.count, 1, 'exactly one delivery for the line');

    // Whatever key A consumed is accounted for: either the customer has it, or
    // it is a recorded orphan written off as shrinkage. Never simply lost.
    const accounted = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM issued_codes
        WHERE code IN (SELECT code FROM supplier_stub.issuances WHERE order_item_id = $1)`,
      [itemId],
    );
    assert.equal(
      accounted.rows[0]?.count,
      1,
      'every key the supplier consumed must be in the registry, delivered or written off',
    );
  });

  it('never lets one code reach two lines, across the whole database', async () => {
    // The invariant stated globally rather than per scenario. issued_codes has a
    // primary key on the code, so this is really asserting that every code that
    // was ever delivered went through the registry.
    const shared = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM (SELECT code FROM deliveries GROUP BY code HAVING count(DISTINCT order_item_id) > 1) duplicates`,
    );
    assert.equal(shared.rows[0]?.count, 0, 'no code may be delivered to two lines');

    const unregistered = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM deliveries d
        WHERE NOT EXISTS (SELECT 1 FROM issued_codes ic WHERE ic.code = d.code)`,
    );
    assert.equal(unregistered.rows[0]?.count, 0, 'every delivered code must be in the registry');

    const money = await harness.api.inject({ url: '/admin/money', headers: ADMIN });
    assert.equal(money.statusCode, 200, `money must still add up: ${money.body}`);
  });

  it('finds and resolves supplier claims nobody scheduled, without being asked', async () => {
    // Requirement 4. The delivery path schedules a reconciliation when it gives
    // up on an unanswered call, so the interesting case is when that scheduling
    // never survived — a worker died, or the job went dead. The claim is then a
    // row asserting "a supplier may have consumed a key for us" with nothing
    // driving it to a conclusion.
    // A genuinely unresolved claim, produced by the real path rather than
    // forged: A consumes a key and then goes completely quiet, so the order is
    // served by B and A is left holding a code nobody knows about.
    await harness.chaos(SUPPLIER_A, {
      forced_outcome: 'timeout',
      hang_ms: 60_000,
      issue_before_hang: true,
      hang_before_lookup: true,
    });

    const { orderId, amount } = await harness.createOrder('SUB-YT-3M');
    const itemId = await harness.singleItemId(orderId);
    await pay(harness, orderId, amount, 'sweep');
    await harness.drain();

    assert.equal(
      ((await harness.getOrder(orderId)) as unknown as OrderView).items[0]?.delivery?.supplier,
      SUPPLIER_B,
      'the fallback must have served the customer while A stayed silent',
    );

    // Now lose the scheduling. This is the part being tested: without the job,
    // nothing is driving A's claim to a conclusion, and the key it consumed
    // would silently vanish from the books.
    await harness.pool.query(`DELETE FROM jobs WHERE kind = 'reconcile_supplier_request'`);
    await harness.pool.query(
      `UPDATE supplier_requests SET last_sent_at = now() - interval '1 hour' WHERE order_item_id = $1`,
      [itemId],
    );
    await harness.chaos(SUPPLIER_A, { forced_outcome: null, hang_before_lookup: false });

    const before = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    assert.ok(
      (before.json() as { unresolved_supplier_requests: unknown[] }).unresolved_supplier_requests.length > 0,
      'the forged claim must show up as unresolved',
    );

    // Nobody names the request. The sweep finds it on its own.
    const swept = await harness.api.inject({ method: 'POST', url: '/admin/reconcile-suppliers', headers: ADMIN });
    assert.ok((swept.json() as { scheduled: number }).scheduled > 0, 'the sweep must schedule the claim it found');
    await harness.drain();

    const after = await harness.api.inject({ url: '/admin/reconciliation', headers: ADMIN });
    const body = after.json() as {
      unresolved_supplier_requests: unknown[];
      orphan_issuances: Array<{ orderId: string }>;
    };
    assert.deepEqual(
      body.unresolved_supplier_requests,
      [],
      'the claim must have been resolved without anyone naming it',
    );

    // Resolved means accounted for, not forgotten. A's key was consumed with no
    // sale behind it, so it is a recorded orphan written off as shrinkage.
    assert.ok(
      body.orphan_issuances.some((row) => row.orderId === orderId),
      'the key the silent supplier consumed must be written off, not lost',
    );

    const shrinkage = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger_entries
        WHERE order_id = $1 AND account = 'shrinkage'`,
      [orderId],
    );
    assert.ok((shrinkage.rows[0]?.count ?? 0) > 0, 'and the write off must be in the journal');

    const money = await harness.api.inject({ url: '/admin/money', headers: ADMIN });
    assert.equal(money.statusCode, 200, 'the customer side of the books is untouched by supplier shrinkage');
  });
});
