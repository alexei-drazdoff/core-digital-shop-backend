import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { RefundRecord, RefundRepository } from '../../../application/ports/repositories.js';

const COLUMNS = 'order_id, order_item_id, amount_minor, currency, reason, created_at';

interface RefundRow {
  order_id: string;
  order_item_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  created_at: Date;
}

function toRefund(row: RefundRow): RefundRecord {
  return {
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class PgRefundRepository implements RefundRepository {
  /**
   * The refund side of exactly-once.
   *
   * UNIQUE (order_item_id) means the database admits one refund per line however
   * many times settlement runs, which is what lets settlement be a plain
   * at-least-once job with no idempotency bookkeeping of its own. A false return
   * is the normal answer on a replay, not an error.
   */
  async recordIfAbsent(tx: TransactionScope, refund: Omit<RefundRecord, 'createdAt'>): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO refunds (order_id, order_item_id, amount_minor, currency, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_item_id) DO NOTHING
       RETURNING id`,
      [refund.orderId, refund.orderItemId, refund.amountMinor, refund.currency, refund.reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findByOrder(exec: Executor, orderId: string): Promise<readonly RefundRecord[]> {
    const result = await exec.query<RefundRow>(
      `SELECT ${COLUMNS} FROM refunds WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );
    return result.rows.map(toRefund);
  }
}
