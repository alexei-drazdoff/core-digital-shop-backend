import type { Executor } from '../pool.js';
import type {
  ReconciliationReport,
  ReconciliationRepository,
  ReconciliationRow,
} from '../../../application/ports/reconciliation.js';
import type { LedgerRepository } from '../../../application/ports/repositories.js';

interface RawRow {
  order_id: string;
  sku: string;
  status: string;
  amount_minor: number;
  detail: string;
  since: Date;
}

const toRows = (rows: readonly RawRow[]): ReconciliationRow[] =>
  rows.map((row) => ({
    orderId: row.order_id,
    sku: row.sku,
    status: row.status,
    amountMinor: row.amount_minor,
    detail: row.detail,
    since: row.since,
  }));

export class PgReconciliationRepository implements ReconciliationRepository {
  constructor(
    private readonly exec: Executor,
    private readonly ledger: LedgerRepository,
  ) {}

  async build(staleAfter: Date): Promise<ReconciliationReport> {
    const [
      paidNotDelivered,
      deliveredNotPaid,
      doubleSettled,
      unsettledOrders,
      unresolved,
      orphans,
      deferred,
      deadJobs,
      ledgerImbalances,
      ledgerByAccount,
    ] = await Promise.all([
      this.paidNotSettled(staleAfter),
      this.deliveredNotPaid(),
      this.deliveredAndRefunded(),
      this.unsettledOrders(staleAfter),
      this.unresolvedSupplierRequests(),
      this.orphanIssuances(),
      this.deferredPaymentEvents(),
      this.deadJobs(),
      this.ledger.unbalancedGroups(this.exec),
      this.ledger.balanceByAccount(this.exec),
    ]);

    return {
      generatedAt: new Date(),
      paidNotDelivered,
      deliveredNotPaid,
      doubleSettledItems: doubleSettled,
      unsettledOrders,
      unresolvedSupplierRequests: unresolved,
      orphanIssuances: orphans,
      deferredPaymentEvents: deferred,
      deadJobs,
      ledgerImbalances,
      ledgerByAccount,
      // Orphans are deliberately excluded from the health verdict: they are a
      // recorded, balanced write off, not an open discrepancy. Everything else
      // represents work the system still owes somebody, or money that does not
      // add up.
      healthy:
        paidNotDelivered.length === 0 &&
        deliveredNotPaid.length === 0 &&
        doubleSettled.length === 0 &&
        unsettledOrders.length === 0 &&
        unresolved.length === 0 &&
        deferred.length === 0 &&
        deadJobs.length === 0 &&
        ledgerImbalances.length === 0,
    };
  }

  /**
   * Lines the customer paid for and has neither received nor been refunded for.
   *
   * This is per LINE, and that is the whole point at this stage. Keying it off
   * the order status the way the first stage did would call a basket healthy
   * while one of its three lines sat stuck forever, because the order row has
   * nothing to say about the lines underneath it.
   *
   * The deadline is measured from paid_at, not from updated_at. Using updated_at
   * made the report blind to exactly the rows it exists to catch: the recovery
   * sweep retries a stuck line every scan, each retry writes updated_at = now(),
   * and the row drops back out of the window before anybody sees it. How long
   * the customer has been waiting is a property of when the money arrived, and
   * nothing the retry loop does should reset it.
   */
  private async paidNotSettled(staleAfter: Date): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT i.order_id, i.sku, i.status, i.price_minor AS amount_minor,
              'paid line with neither a delivery nor a refund (item ' || i.id || ')' AS detail,
              COALESCE(o.paid_at, i.updated_at) AS since
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE i.status IN ('pending', 'delivering', 'out_of_stock', 'delivery_failed')
          AND o.paid_at IS NOT NULL
          AND COALESCE(o.paid_at, i.updated_at) < $1
        ORDER BY COALESCE(o.paid_at, i.updated_at)`,
      [staleAfter],
    );
    return toRows(result.rows);
  }

  /**
   * A delivery with no applied payment behind it.
   *
   * The check is against the ledger rather than against the order status,
   * because the status is written by the same code path that might be wrong. If
   * money was captured there is a psp_cash debit for it, and if there is not,
   * goods left the building for free.
   */
  private async deliveredNotPaid(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT d.order_id, i.sku, i.status, i.price_minor AS amount_minor,
              'line delivered with no captured payment in the ledger (item ' || d.order_item_id || ')' AS detail,
              d.delivered_at AS since
         FROM deliveries d
         JOIN order_items i ON i.id = d.order_item_id
        WHERE NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.order_id = d.order_id AND le.account = 'psp_cash' AND le.direction = 'debit'
              )
        ORDER BY d.delivered_at`,
    );
    return toRows(result.rows);
  }

  /**
   * The one failure that breaks the money invariant while every account still
   * balances: a line that was both delivered and refunded.
   *
   * The customer would have the code AND the money, and because both the
   * delivery and the refund are individually balanced double entries, no
   * per-account sum and no group check would notice. It cannot be expressed as a
   * table constraint, so it is asked directly and it fails the health verdict.
   */
  private async deliveredAndRefunded(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT i.order_id, i.sku, i.status, i.price_minor AS amount_minor,
              'line ' || i.id || ' is both delivered and refunded' AS detail,
              GREATEST(d.delivered_at, r.created_at) AS since
         FROM order_items i
         JOIN deliveries d ON d.order_item_id = i.id
         JOIN refunds r ON r.order_item_id = i.id
        ORDER BY GREATEST(d.delivered_at, r.created_at)`,
    );
    return toRows(result.rows);
  }

  /**
   * Orders whose lines are all resolved but whose own status never caught up.
   *
   * The window between the last line finishing and settlement committing is
   * real and is opened by every normal order: the delivery commits in one
   * transaction and the settlement job is enqueued in the next. So this is not
   * an error in itself, only if it PERSISTS, and the deadline is what makes that
   * distinction. Without it the endpoint would answer 409 for a moment on every
   * healthy order and anything polling it would flap.
   *
   * An order left here past the deadline has the right money but lies to the
   * customer about what happened.
   */
  private async unsettledOrders(staleAfter: Date): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT o.id AS order_id, '' AS sku, o.status, o.amount_minor,
              'every line is resolved but the order was never settled' AS detail,
              o.updated_at AS since
         FROM orders o
        WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
          AND o.updated_at < $1
          AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)
          AND NOT EXISTS (
                SELECT 1 FROM order_items i
                 WHERE i.order_id = o.id AND i.status NOT IN ('delivered', 'refunded')
              )
        ORDER BY o.updated_at`,
      [staleAfter],
    );
    return toRows(result.rows);
  }

  private async unresolvedSupplierRequests(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT sr.order_id, i.sku, sr.state AS status, i.price_minor AS amount_minor,
              'supplier ' || sr.supplier || ' outcome unknown, request ' || sr.request_id AS detail,
              sr.last_sent_at AS since
         FROM supplier_requests sr
         JOIN order_items i ON i.id = sr.order_item_id
        WHERE sr.state IN ('in_flight', 'unknown')
        ORDER BY sr.last_sent_at`,
    );
    return toRows(result.rows);
  }

  private async orphanIssuances(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT oi.order_id, i.sku, 'orphan' AS status, i.price_minor AS amount_minor,
              'code consumed at ' || oi.supplier || ' with no sale behind it: ' || COALESCE(oi.note, '') AS detail,
              oi.detected_at AS since
         FROM orphan_issuances oi
         JOIN order_items i ON i.id = oi.order_item_id
        ORDER BY oi.detected_at`,
    );
    return toRows(result.rows);
  }

  private async deferredPaymentEvents(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT pe.order_id, '' AS sku,
              'deferred' AS status, pe.amount_minor,
              'payment event ' || pe.event_id || ' is waiting for its order' AS detail,
              pe.received_at AS since
         FROM payment_events pe
        WHERE pe.processed_at IS NULL
        ORDER BY pe.received_at`,
    );
    return toRows(result.rows);
  }

  private async deadJobs(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT COALESCE(j.payload->>'orderId', j.payload->>'orderItemId', j.dedupe_key) AS order_id,
              '' AS sku, 'dead_job' AS status, 0::bigint AS amount_minor,
              j.kind || ' gave up after ' || j.attempts || ' attempts: ' || COALESCE(j.last_error, '') AS detail,
              j.updated_at AS since
         FROM jobs j
        WHERE j.state = 'dead'
        ORDER BY j.updated_at`,
    );
    return toRows(result.rows);
  }
}
