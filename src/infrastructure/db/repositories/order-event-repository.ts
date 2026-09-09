import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { OrderEvent } from '../../../domain/order/projection.js';
import type { AppendOrderEvent, OrderEventRepository, PeriodTotals } from '../../../application/ports/history.js';

interface OrderEventRow {
  id: number;
  order_id: string;
  order_item_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}

const COLUMNS = 'id, order_id, order_item_id, type, payload, occurred_at, recorded_at';

function toEvent(row: OrderEventRow): OrderEvent {
  return {
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    type: row.type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

export class PgOrderEventRepository implements OrderEventRepository {
  /**
   * Appends facts inside the caller's transaction.
   *
   * Taking a TransactionScope is the whole point, exactly as it is for the job
   * queue: the fact and the state change it describes commit together or not at
   * all. A history written outside the transaction would drift from the rows it
   * claims to explain, and a drifting history is worse than none — it looks
   * authoritative.
   */
  async append(tx: TransactionScope, events: readonly AppendOrderEvent[]): Promise<void> {
    if (events.length === 0) return;

    await tx.query(
      // COALESCE rather than relying on the column default: a value supplied as
      // an explicit NULL is supplied, not omitted, so the DEFAULT never fires.
      // Most facts are ones we cause ourselves, where "when it happened" and
      // "when we recorded it" are the same instant.
      `INSERT INTO order_events (order_id, order_item_id, type, payload, occurred_at)
       SELECT order_id, order_item_id, type, payload, COALESCE(occurred_at, now())
         FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::timestamptz[])
              AS t(order_id, order_item_id, type, payload, occurred_at)`,
      [
        events.map((event) => event.orderId),
        events.map((event) => event.orderItemId ?? null),
        events.map((event) => event.type),
        events.map((event) => JSON.stringify(event.payload ?? {})),
        events.map((event) => event.occurredAt ?? null),
      ],
    );
  }

  async findByOrder(exec: Executor, orderId: string): Promise<readonly OrderEvent[]> {
    const result = await exec.query<OrderEventRow>(
      `SELECT ${COLUMNS} FROM order_events WHERE order_id = $1 ORDER BY recorded_at, id`,
      [orderId],
    );
    return result.rows.map(toEvent);
  }

  /**
   * Money moved in a period, straight out of the journal.
   *
   * Bounded by created_at, and the ledger is append-only and never back-dated,
   * so re-running a report for a closed period returns the same numbers forever.
   * That is the actual content of "итоги за период считаются из этой истории и
   * сходятся": not that the arithmetic works, but that it does not change.
   */
  async periodTotals(exec: Executor, from: Date, to: Date): Promise<PeriodTotals> {
    const [accounts, movements] = await Promise.all([
      exec.query<{ account: string; signed_minor: string }>(
        `SELECT account, COALESCE(SUM(signed_minor), 0)::bigint AS signed_minor
           FROM ledger_entries
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY account
          ORDER BY account`,
        [from, to],
      ),
      exec.query<{ orders_paid: number; items_delivered: number; items_refunded: number }>(
        `SELECT
           (SELECT count(*)::int FROM orders WHERE paid_at >= $1 AND paid_at < $2) AS orders_paid,
           (SELECT count(*)::int FROM deliveries WHERE delivered_at >= $1 AND delivered_at < $2) AS items_delivered,
           (SELECT count(*)::int FROM refunds WHERE created_at >= $1 AND created_at < $2) AS items_refunded`,
        [from, to],
      ),
    ]);

    const byAccount = new Map(accounts.rows.map((row) => [row.account, Number(row.signed_minor)]));
    const counts = movements.rows[0] ?? { orders_paid: 0, items_delivered: 0, items_refunded: 0 };

    // psp_cash is debit-normal, so its signed sum IS cash in minus cash out.
    // revenue and refund are the customer side of the same movement, which is
    // why the identity below is a real check and not a restatement.
    const capturedMinor = -(byAccount.get('revenue') ?? 0);
    const refundedMinor = byAccount.get('refund') ?? 0;

    return {
      from,
      to,
      byAccount: [...byAccount.entries()].map(([account, signedMinor]) => ({ account, signedMinor })),
      capturedMinor,
      refundedMinor,
      netRevenueMinor: capturedMinor - refundedMinor,
      cashMovementMinor: byAccount.get('psp_cash') ?? 0,
      ordersPaid: counts.orders_paid,
      itemsDelivered: counts.items_delivered,
      itemsRefunded: counts.items_refunded,
      // Cash still held for the period must equal what was captured minus what
      // went back. Two different account sums agreeing is the check; if they
      // ever disagree the journal has a hole the per-group balance missed.
      balanced: (byAccount.get('psp_cash') ?? 0) === capturedMinor - refundedMinor,
    };
  }
}
