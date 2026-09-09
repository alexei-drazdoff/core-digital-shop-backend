import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { OrderItem } from '../../../domain/order/order.js';
import type { OrderItemStatus } from '../../../domain/order/status.js';
import type { OrderItemRepository } from '../../../application/ports/repositories.js';

interface OrderItemRow {
  id: string;
  order_id: string;
  line_no: number;
  product_id: number;
  sku: string;
  price_minor: number;
  cost_minor: number;
  currency: string;
  status: OrderItemStatus;
  rounds: number;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
  refunded_at: Date | null;
}

const COLUMNS = `id, order_id, line_no, product_id, sku, price_minor, cost_minor, currency,
                 status, rounds, created_at, updated_at, delivered_at, refunded_at`;

/** The same list qualified for the one query that joins orders. */
const ITEM_COLUMNS = `i.id, i.order_id, i.line_no, i.product_id, i.sku, i.price_minor, i.cost_minor,
                      i.currency, i.status, i.rounds, i.created_at, i.updated_at, i.delivered_at, i.refunded_at`;

function toItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    lineNo: row.line_no,
    productId: row.product_id,
    sku: row.sku,
    priceMinor: row.price_minor,
    costMinor: row.cost_minor,
    currency: row.currency,
    status: row.status,
    rounds: row.rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    refundedAt: row.refunded_at,
  };
}

export class PgOrderItemRepository implements OrderItemRepository {
  async findByOrder(exec: Executor, orderId: string): Promise<readonly OrderItem[]> {
    const result = await exec.query<OrderItemRow>(
      `SELECT ${COLUMNS} FROM order_items WHERE order_id = $1 ORDER BY line_no`,
      [orderId],
    );
    return result.rows.map(toItem);
  }

  async findById(exec: Executor, orderItemId: string): Promise<OrderItem | null> {
    const result = await exec.query<OrderItemRow>(`SELECT ${COLUMNS} FROM order_items WHERE id = $1`, [orderItemId]);
    const row = result.rows[0];
    return row ? toItem(row) : null;
  }

  async lockById(tx: TransactionScope, orderItemId: string): Promise<OrderItem | null> {
    const result = await tx.query<OrderItemRow>(
      `SELECT ${COLUMNS} FROM order_items WHERE id = $1 FOR UPDATE`,
      [orderItemId],
    );
    const row = result.rows[0];
    return row ? toItem(row) : null;
  }

  /**
   * Locks every line of an order, always by line_no.
   *
   * The fixed order is the point. Settlement has to see all the lines at once to
   * decide the order's fate, and two settlements running concurrently on the
   * same order would deadlock the moment they took the same locks in different
   * sequences. Sorting by a column that never changes removes that possibility
   * rather than making it rare.
   */
  async lockByOrder(tx: TransactionScope, orderId: string): Promise<readonly OrderItem[]> {
    const result = await tx.query<OrderItemRow>(
      `SELECT ${COLUMNS} FROM order_items WHERE order_id = $1 ORDER BY line_no FOR UPDATE`,
      [orderId],
    );
    return result.rows.map(toItem);
  }

  /**
   * The conditional status transition, mirroring the order-level one.
   *
   * A false return means somebody else moved this line first, and the loser must
   * do nothing. That is how two workers that both believe they own a line end up
   * with exactly one of them acting.
   */
  async transition(
    tx: TransactionScope,
    orderItemId: string,
    from: OrderItemStatus | readonly OrderItemStatus[],
    to: OrderItemStatus,
  ): Promise<boolean> {
    const expected = Array.isArray(from) ? from : [from as OrderItemStatus];
    const result = await tx.query(
      `UPDATE order_items
          SET status = $3,
              updated_at = now(),
              delivered_at = CASE WHEN $3 = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END,
              refunded_at = CASE WHEN $3 = 'refunded' AND refunded_at IS NULL THEN now() ELSE refunded_at END
        WHERE id = $1 AND status = ANY($2::text[])`,
      [orderItemId, expected, to],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Spends one delivery round.
   *
   * A round is a full pass through every supplier, not one HTTP attempt: the
   * retries inside a single supplier are the timeout trap being handled, and
   * counting them here would make a slow supplier look like an unfulfillable
   * line. Returns the new count so the caller can decide whether the budget is
   * exhausted without a second read.
   */
  async countRound(tx: TransactionScope, orderItemId: string): Promise<number> {
    const result = await tx.query<{ rounds: number }>(
      `UPDATE order_items SET rounds = rounds + 1, updated_at = now() WHERE id = $1 RETURNING rounds`,
      [orderItemId],
    );
    return result.rows[0]?.rounds ?? 0;
  }

  /**
   * Returns lines abandoned in `delivering` to a claimable state.
   *
   * The line-level counterpart of JobQueue.requeueAbandoned, and necessary for
   * the same reason. `delivering` means "a worker owns this right now", so the
   * claim that starts a delivery deliberately refuses to take a line already in
   * it — otherwise two workers would call suppliers for the same line in
   * parallel. When the owning worker dies, that refusal becomes a trap: nothing
   * can claim the line, and settlement will not refund it either, because
   * refunding something a supplier call might still be in flight for is how a
   * customer ends up with both the code and the money.
   *
   * Releasing it past the deadline is safe precisely because the deadline is
   * what makes "a worker owns this" false. `delivery_failed` rather than
   * `pending` because that is what actually happened: a delivery was attempted
   * and did not report a result.
   */
  async releaseStaleDelivering(tx: TransactionScope, olderThan: Date, limit: number): Promise<number> {
    const result = await tx.query(
      `UPDATE order_items
          SET status = 'delivery_failed', updated_at = now()
        WHERE id IN (
              SELECT i.id
                FROM order_items i
                JOIN orders o ON o.id = i.order_id
               WHERE i.status = 'delivering'
                 AND o.paid_at IS NOT NULL
                 AND i.updated_at < $1
               ORDER BY i.updated_at
               LIMIT $2
              )`,
      [olderThan, limit],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Unresolved lines of paid orders that still have delivery attempts left.
   *
   * Three filters, each removing work that would be wrong to do:
   *
   * the join to orders makes this a list of obligations rather than a list of
   * rows, because a line of an unpaid order owes nobody anything and fetching a
   * code for it would spend real stock on a sale that has not happened;
   *
   * `rounds < maxRounds` leaves out the lines whose budget is spent. The only
   * correct action for those is a refund, and settlement is what does that.
   * Re-enqueueing one would have the sweep and the settlement pull the same line
   * in opposite directions on every scan;
   *
   * `updated_at` is what "stopped moving" means, and it is deliberately not the
   * column the reconciliation report keys off. See 007.
   */
  async findStuck(
    exec: Executor,
    olderThan: Date,
    limit: number,
    maxRounds: number,
  ): Promise<readonly OrderItem[]> {
    const result = await exec.query<OrderItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE i.status IN ('pending', 'delivering', 'out_of_stock', 'delivery_failed')
          AND o.paid_at IS NOT NULL
          AND o.status <> 'payment_failed'
          AND i.rounds < $3
          AND i.updated_at < $1
        ORDER BY i.updated_at
        LIMIT $2`,
      [olderThan, limit, maxRounds],
    );
    return result.rows.map(toItem);
  }
}
