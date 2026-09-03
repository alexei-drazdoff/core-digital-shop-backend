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
      unresolved,
      orphans,
      deferred,
      deadJobs,
      ledgerImbalances,
      ledgerByAccount,
    ] = await Promise.all([
      this.paidNotDelivered(staleAfter),
      this.deliveredNotPaid(),
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
      unresolvedSupplierRequests: unresolved,
      orphanIssuances: orphans,
      deferredPaymentEvents: deferred,
      deadJobs,
      ledgerImbalances,
      ledgerByAccount,
      // Orphans are deliberately excluded from the health verdict: they are a
      // recorded, balanced write off, not an open discrepancy. Everything else
      // represents work the system still owes somebody.
      healthy:
        paidNotDelivered.length === 0 &&
        deliveredNotPaid.length === 0 &&
        unresolved.length === 0 &&
        deferred.length === 0 &&
        deadJobs.length === 0 &&
        ledgerImbalances.length === 0,
    };
  }

  /**
   * Paid, past the deadline, and with no delivery row. NOT LEFT JOIN on a large
   * table but an anti join on the unique index, so it stays cheap.
   *
   * The deadline is measured from paid_at, not from updated_at. Using updated_at
   * here made the report blind to exactly the orders it exists to catch: the
   * recovery sweep retries a stuck order every scan, each retry transitions the
   * status and writes updated_at = now(), and the row drops back out of the
   * window before anybody sees it. An order that cannot be delivered would then
   * flip in and out of the report forever while the endpoint kept answering
   * healthy. How long the customer has been waiting is a property of when the
   * money arrived, and nothing the retry loop does should reset it.
   */
  private async paidNotDelivered(staleAfter: Date): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT o.id AS order_id, o.sku, o.status, o.amount_minor,
              'paid but no delivery recorded' AS detail,
              COALESCE(o.paid_at, o.updated_at) AS since
         FROM orders o
    LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
          AND d.order_id IS NULL
          AND COALESCE(o.paid_at, o.updated_at) < $1
        ORDER BY COALESCE(o.paid_at, o.updated_at)`,
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
      `SELECT o.id AS order_id, o.sku, o.status, o.amount_minor,
              'delivered with no captured payment in the ledger' AS detail, d.delivered_at AS since
         FROM deliveries d
         JOIN orders o ON o.id = d.order_id
        WHERE NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.order_id = o.id AND le.account = 'psp_cash' AND le.direction = 'debit'
              )
        ORDER BY d.delivered_at`,
    );
    return toRows(result.rows);
  }

  private async unresolvedSupplierRequests(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT sr.order_id, o.sku, sr.state AS status, o.amount_minor,
              'supplier ' || sr.supplier || ' outcome unknown, request ' || sr.request_id AS detail,
              sr.last_sent_at AS since
         FROM supplier_requests sr
         JOIN orders o ON o.id = sr.order_id
        WHERE sr.state IN ('in_flight', 'unknown')
        ORDER BY sr.last_sent_at`,
    );
    return toRows(result.rows);
  }

  private async orphanIssuances(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT oi.order_id, o.sku, 'orphan' AS status, o.amount_minor,
              'code consumed at ' || oi.supplier || ' with no sale behind it: ' || COALESCE(oi.note, '') AS detail,
              oi.detected_at AS since
         FROM orphan_issuances oi
         JOIN orders o ON o.id = oi.order_id
        ORDER BY oi.detected_at`,
    );
    return toRows(result.rows);
  }

  private async deferredPaymentEvents(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT pe.order_id, COALESCE(o.sku, '(unknown sku)') AS sku,
              'deferred' AS status, pe.amount_minor,
              'payment event ' || pe.event_id || ' is waiting for its order' AS detail,
              pe.received_at AS since
         FROM payment_events pe
    LEFT JOIN orders o ON o.id = pe.order_id
        WHERE pe.processed_at IS NULL
        ORDER BY pe.received_at`,
    );
    return toRows(result.rows);
  }

  private async deadJobs(): Promise<ReconciliationRow[]> {
    const result = await this.exec.query<RawRow>(
      `SELECT COALESCE(j.payload->>'orderId', j.dedupe_key) AS order_id,
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
