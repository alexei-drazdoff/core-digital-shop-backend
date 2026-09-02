import { request as httpRequest } from 'undici';
import type { AppServer } from '../types.js';
import type { Container } from '../../../composition/container.js';
import { deliveryJobDedupeKey } from '../../../application/use-cases/apply-payment-event.js';
import { replenishBody } from '../schemas.js';
import { SUPPLIER_A } from '../../../shared/constants.js';

export function registerAdminRoutes(app: AppServer, container: Container): void {
  const { config, pool, uow, queue, repositories, useCases, logger } = container;

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
      unresolved_supplier_requests: report.unresolvedSupplierRequests,
      orphan_issuances: report.orphanIssuances,
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

  /** Manually pushes one order back through delivery. Safe: it only enqueues. */
  app.post('/admin/orders/:id/redeliver', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await repositories.orders.findById(pool, id);
    if (!order) return reply.code(404).send({ error: 'order_not_found' });

    const enqueued = await uow.withTransaction((tx) =>
      queue.enqueue(tx, { kind: 'deliver_order', dedupeKey: deliveryJobDedupeKey(id), payload: { orderId: id } }),
    );
    logger.info({ order_id: id, enqueued }, 'manual redelivery requested');
    return { order_id: id, enqueued, status: order.status };
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

  app.post('/admin/sync-stock', async () => useCases.syncStock.execute());
}
