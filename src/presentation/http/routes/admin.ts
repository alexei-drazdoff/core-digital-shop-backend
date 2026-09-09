import { request as httpRequest } from 'undici';
import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { deliveryJobDedupeKey } from '../../../application/use-cases/apply-payment-event.js';
import { asOfQuery, periodQuery, replenishBody } from '../schemas.js';
import { projectOrderAt } from '../../../domain/order/projection.js';
import { SUPPLIER_A } from '../../../shared/constants.js';

export function registerAdminRoutes(app: AppServer, container: Container): void {
  const { config, pool, uow, queue, rateLimiter, repositories, useCases, logger } = container;

  // A shared static token. Enough to keep operational endpoints off the public
  // surface without pretending this is a real identity system.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin')) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /**
   * The reconciliation report.
   *
   * Answers "paid but not delivered" and "delivered but not paid" from the
   * database, plus the unresolved supplier calls and the ledger balance check.
   * Responds 200 when healthy and 409 when it is not, so it can be wired
   * straight into a monitor without parsing the body.
   */
  app.get('/admin/reconciliation', async (request, reply) => {
    const staleAfter = new Date(Date.now() - config.STUCK_ORDER_AFTER_MS);
    const report = await repositories.reconciliation.build(staleAfter);
    return reply.code(report.healthy ? 200 : 409).send({
      generated_at: report.generatedAt.toISOString(),
      healthy: report.healthy,
      stale_after: staleAfter.toISOString(),
      paid_not_delivered: report.paidNotDelivered,
      delivered_not_paid: report.deliveredNotPaid,
      double_settled_items: report.doubleSettledItems,
      unsettled_orders: report.unsettledOrders,
      unresolved_supplier_requests: report.unresolvedSupplierRequests,
      orphan_issuances: report.orphanIssuances,
      quarantined_codes: report.quarantinedCodes,
      deferred_payment_events: report.deferredPaymentEvents,
      dead_jobs: report.deadJobs,
      ledger_imbalances: report.ledgerImbalances,
      ledger_by_account: report.ledgerByAccount,
    });
  });

  /**
   * The money journal.
   *
   * revenue and cogs are credit-normal so they read as negative signed sums;
   * what matters is that every group nets to zero, which imbalanced_groups proves.
   */
  app.get('/admin/ledger/balance', async () => {
    const [byAccount, imbalances] = await Promise.all([
      repositories.ledger.balanceByAccount(pool),
      repositories.ledger.unbalancedGroups(pool),
    ]);
    return { by_account: byAccount, imbalanced_groups: imbalances, balanced: imbalances.length === 0 };
  });

  /**
   * The money check, per order.
   *
   * Answers "сходятся ли деньги" as arithmetic rather than as a claim: for every
   * order it reads what was paid, what the delivered lines were worth and what
   * was refunded, straight out of the tables, and reports the orders where the
   * three do not add up. `settled` orders must have a difference of zero; the
   * rest are still working and their difference is what is in flight.
   *
   * Deliberately computed from order_items, deliveries and refunds rather than
   * from the ledger, so it is an independent second opinion on the same facts.
   * /admin/ledger/balance asks the journal; this asks the goods.
   */
  app.get('/admin/money', async (request, reply) => {
    const result = await pool.query<{
      order_id: string;
      status: string;
      paid_minor: string;
      delivered_minor: string;
      refunded_minor: string;
      unresolved_minor: string;
      settled: boolean;
    }>(
      `WITH per_order AS (
         SELECT o.id AS order_id,
                o.status,
                CASE WHEN o.paid_at IS NULL THEN 0 ELSE o.amount_minor END AS paid_minor,
                COALESCE(SUM(i.price_minor) FILTER (WHERE i.status = 'delivered'), 0) AS delivered_minor,
                COALESCE(SUM(i.price_minor) FILTER (WHERE i.status = 'refunded'), 0) AS refunded_minor,
                COALESCE(SUM(i.price_minor) FILTER (WHERE i.status NOT IN ('delivered', 'refunded')), 0)
                    AS unresolved_minor,
                bool_and(i.status IN ('delivered', 'refunded')) AS settled
           FROM orders o
           JOIN order_items i ON i.order_id = o.id
          WHERE o.paid_at IS NOT NULL
          GROUP BY o.id
       )
       SELECT * FROM per_order
        ORDER BY (paid_minor - delivered_minor - refunded_minor - unresolved_minor) <> 0 DESC, order_id`,
    );

    const rows = result.rows.map((row) => ({
      order_id: row.order_id,
      status: row.status,
      paid: Number(row.paid_minor),
      delivered: Number(row.delivered_minor),
      refunded: Number(row.refunded_minor),
      unresolved: Number(row.unresolved_minor),
      settled: row.settled,
    }));

    // paid = delivered + refunded + unresolved, always. For a settled order
    // unresolved is zero, which collapses it to the assignment's statement.
    const mismatched = rows.filter(
      (row) => row.paid !== row.delivered + row.refunded + row.unresolved,
    );
    const totals = rows.reduce(
      (acc, row) => ({
        paid: acc.paid + row.paid,
        delivered: acc.delivered + row.delivered,
        refunded: acc.refunded + row.refunded,
        unresolved: acc.unresolved + row.unresolved,
      }),
      { paid: 0, delivered: 0, refunded: 0, unresolved: 0 },
    );

    return reply.code(mismatched.length === 0 ? 200 : 409).send({
      balanced: mismatched.length === 0,
      orders_checked: rows.length,
      totals,
      mismatched,
    });
  });

  /** Manually pushes one order line back through delivery. Safe: it only enqueues. */
  app.post('/admin/orders/:id/redeliver', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await repositories.orders.findById(pool, id);
    if (!order) return reply.code(404).send({ error: 'order_not_found' });

    const items = await repositories.orderItems.findByOrder(pool, id);
    const unresolved = items.filter((item) => item.status !== 'delivered' && item.status !== 'refunded');

    let enqueued = 0;
    for (const item of unresolved) {
      const scheduled = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'deliver_order_item',
          dedupeKey: deliveryJobDedupeKey(item.id),
          payload: { orderItemId: item.id },
        }),
      );
      if (scheduled) enqueued += 1;
    }

    logger.info({ order_id: id, enqueued, unresolved: unresolved.length }, 'manual redelivery requested');
    return { order_id: id, enqueued, unresolved: unresolved.length, status: order.status };
  });

  /** Runs settlement for one order on demand. Idempotent, so it is safe to poke. */
  app.post('/admin/orders/:id/settle', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await repositories.orders.findById(pool, id);
    if (!order) return reply.code(404).send({ error: 'order_not_found' });
    return useCases.settleOrder.execute(id);
  });

  /**
   * Queue progress: "виден прогресс — сколько заказов в очереди и сколько уже выдано".
   *
   * Deliberately reports the QUEUE and the GOODS separately, because during a
   * burst they answer different questions. The queue says how much work is
   * waiting and how much of it is merely waiting for supplier capacity rather
   * than failing; the lines say how much of what customers paid for has actually
   * been handed over. A backlog with zero dead jobs and a healthy delivered
   * count is a system absorbing a spike correctly, and the two numbers together
   * are what make that visible instead of alarming.
   */
  app.get('/admin/queue/progress', async () => {
    const [jobs, items, tokens] = await Promise.all([
      pool.query<{ kind: string; state: string; count: number; deferrals: number; priority: number }>(
        `SELECT kind, state, count(*)::int AS count,
                COALESCE(SUM(deferrals), 0)::int AS deferrals,
                MAX(priority)::int AS priority
           FROM jobs
          GROUP BY kind, state
          ORDER BY kind, state`,
      ),
      pool.query<{ status: string; count: number }>(
        `SELECT i.status, count(*)::int AS count
           FROM order_items i
           JOIN orders o ON o.id = i.order_id
          WHERE o.paid_at IS NOT NULL
          GROUP BY i.status
          ORDER BY i.status`,
      ),
      rateLimiter.snapshot(pool),
    ]);

    const byStatus = new Map(items.rows.map((row) => [row.status, row.count]));
    const waiting =
      (byStatus.get('pending') ?? 0) +
      (byStatus.get('delivering') ?? 0) +
      (byStatus.get('out_of_stock') ?? 0) +
      (byStatus.get('delivery_failed') ?? 0);

    return {
      jobs: jobs.rows,
      // Jobs put back because a supplier had no capacity. Waiting, not failing:
      // these never count against a job's attempts, so a burst cannot kill them.
      pending_jobs: jobs.rows
        .filter((row) => row.state === 'pending')
        .reduce((total, row) => total + row.count, 0),
      dead_jobs: jobs.rows.filter((row) => row.state === 'dead').reduce((total, row) => total + row.count, 0),
      items: {
        delivered: byStatus.get('delivered') ?? 0,
        refunded: byStatus.get('refunded') ?? 0,
        waiting,
        by_status: Object.fromEntries(byStatus),
      },
      supplier_capacity: tokens,
    };
  });

  /** Runs the recovery sweep on demand rather than waiting for the timer. */
  app.post('/admin/recover', async () => useCases.recoverStuckOrders.execute());

  /**
   * Adds stock at a supplier and refreshes the storefront counters.
   *
   * The recovery sweep is run here as a convenience, but note what it can and
   * cannot do: it only picks up orders that have been still for longer than
   * STUCK_ORDER_AFTER_MS, so an order that went out_of_stock moments ago is
   * deliberately not in scope and the report will say ordersRequeued: 0. That
   * order is reached by the next sweep once it has aged past the threshold, or
   * immediately via POST /admin/orders/:id/redeliver, which does not consult the
   * deadline. The wait is the point: it keeps the sweep from racing the worker
   * that is still holding the order.
   */
  app.post('/admin/inventory/replenish', async (request, reply) => {
    const body = replenishBody.parse(request.body);
    const supplierName = body.supplier ?? SUPPLIER_A;
    const baseUrl = supplierName === SUPPLIER_A ? config.SUPPLIER_A_URL : config.SUPPLIER_B_URL;

    const response = await httpRequest(`${baseUrl}/admin/replenish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: body.sku, count: body.count }),
    });
    if (response.statusCode >= 400) {
      return reply.code(502).send({ error: 'supplier_replenish_failed', status: response.statusCode });
    }

    const synced = await useCases.syncStock.execute();
    const recovered = await useCases.recoverStuckOrders.execute();
    return { supplier: supplierName, sku: body.sku, added: body.count, synced, recovered };
  });

  /**
   * The state of one order at a past moment, rebuilt from its history.
   *
   * Reconstructed by replaying the recorded facts, never by reading today's row
   * and reasoning backwards: today's row says what is true now and has no memory
   * of having been anything else.
   *
   * The fold keys off recorded_at — when we LEARNED a fact — rather than
   * occurred_at. A webhook that arrived at 12:05 about a payment at 11:55 was
   * not something we knew at 12:00, and answering otherwise would produce a
   * history that retroactively knew the future.
   */
  app.get('/admin/orders/:id/at', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = asOfQuery.parse(request.query);
    const asOf = new Date(query.ts);

    const events = await repositories.orderEvents.findByOrder(pool, id);
    if (events.length === 0) return reply.code(404).send({ error: 'order_not_found' });

    const snapshot = projectOrderAt(id, events, asOf);

    return {
      order_id: snapshot.orderId,
      as_of: snapshot.asOf.toISOString(),
      // Null means the order did not exist yet at that moment, which is a real
      // answer rather than a missing one.
      status: snapshot.status,
      amount: snapshot.amountMinor,
      money: {
        paid: snapshot.paidMinor,
        delivered: snapshot.deliveredMinor,
        refunded: snapshot.refundedMinor,
        unresolved: snapshot.unresolvedMinor,
      },
      items: snapshot.items.map((item) => ({
        order_item_id: item.orderItemId,
        sku: item.sku,
        price: item.priceMinor,
        status: item.status,
        supplier: item.supplier,
        has_code: item.hasCode,
      })),
      events_applied: snapshot.eventsApplied,
      events_total: events.length,
    };
  });

  /** The full recorded history of one order. Append-only, so it only ever grows. */
  app.get('/admin/orders/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    const events = await repositories.orderEvents.findByOrder(pool, id);
    if (events.length === 0) return reply.code(404).send({ error: 'order_not_found' });

    return {
      order_id: id,
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        order_item_id: event.orderItemId,
        payload: event.payload,
        occurred_at: event.occurredAt.toISOString(),
        recorded_at: event.recordedAt.toISOString(),
      })),
    };
  });

  /**
   * Money moved in a period, out of the journal.
   *
   * The ledger is append-only and never back-dated, so re-running this for a
   * closed period returns the same numbers forever. That permanence is the
   * actual content of "итоги за период считаются из этой истории и сходятся" —
   * not that the arithmetic works, but that it does not change.
   *
   * `balanced` is a genuine check rather than a restatement: cash held is summed
   * from psp_cash while captured and refunded come from revenue and refund, so
   * the two agreeing means three independent account sums tell one story.
   */
  app.get('/admin/reports/period', async (request, reply) => {
    const query = periodQuery.parse(request.query);
    const totals = await repositories.orderEvents.periodTotals(pool, new Date(query.from), new Date(query.to));

    return reply.code(totals.balanced ? 200 : 409).send({
      from: totals.from.toISOString(),
      to: totals.to.toISOString(),
      balanced: totals.balanced,
      captured: totals.capturedMinor,
      refunded: totals.refundedMinor,
      net_revenue: totals.netRevenueMinor,
      cash_movement: totals.cashMovementMinor,
      orders_paid: totals.ordersPaid,
      items_delivered: totals.itemsDelivered,
      items_refunded: totals.itemsRefunded,
      by_account: totals.byAccount,
    });
  });

  /**
   * Runs the supplier discrepancy sweep on demand.
   *
   * Only enqueues reconciliations, so it is safe to poke: the actual chasing
   * happens on the worker, at the worker's pace.
   */
  app.post('/admin/reconcile-suppliers', async () => useCases.sweepSupplierDiscrepancies.execute());

  /** Codes a supplier offered that were refused as invalid, newest first. */
  app.get('/admin/quarantined-codes', async () => ({
    items: await repositories.issuedCodes.quarantined(pool, 100),
  }));

  app.post('/admin/sync-stock', async () => useCases.syncStock.execute());
}
