/**
 * The reconciliation report.
 *
 * Every field is a question the business would ask after an incident, phrased so
 * that an empty list is the healthy answer. Nothing here is derived from
 * application state: it is all read back out of the database, because a report
 * that trusts the same code that created the problem is not a report.
 */
export interface ReconciliationRow {
  readonly orderId: string;
  readonly sku: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly detail: string;
  readonly since: Date;
}

export interface ReconciliationReport {
  readonly generatedAt: Date;
  /** Money taken, goods not handed over. The one that costs customer trust. */
  readonly paidNotDelivered: readonly ReconciliationRow[];
  /** Goods handed over, no confirmed payment behind them. The one that costs money. */
  readonly deliveredNotPaid: readonly ReconciliationRow[];
  /** Supplier calls whose outcome is still unknown, so stock may be silently consumed. */
  readonly unresolvedSupplierRequests: readonly ReconciliationRow[];
  /** Stock consumed with no sale behind it, already written off as shrinkage. */
  readonly orphanIssuances: readonly ReconciliationRow[];
  /** Webhooks that arrived before their order and are still waiting. */
  readonly deferredPaymentEvents: readonly ReconciliationRow[];
  /** Jobs that exhausted their retries. Visible rather than silently dropped. */
  readonly deadJobs: readonly ReconciliationRow[];
  /** Must always be empty. Anything here means the double entry invariant broke. */
  readonly ledgerImbalances: ReadonlyArray<{ groupId: string; signedMinor: number }>;
  readonly ledgerByAccount: ReadonlyArray<{ account: string; signedMinor: number }>;
  readonly healthy: boolean;
}

export interface ReconciliationRepository {
  build(staleAfter: Date): Promise<ReconciliationReport>;
}
