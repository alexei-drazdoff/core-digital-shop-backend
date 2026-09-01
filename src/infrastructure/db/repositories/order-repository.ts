import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { Order } from '../../../domain/order/order.js';
import type { OrderStatus } from '../../../domain/order/status.js';
import type { OrderRepository } from '../../../application/ports/repositories.js';

interface OrderRow {
  id: string;
  product_id: number;
  sku: string;
  amount_minor: number;
  currency: string;
  customer_ref: string | null;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  delivered_at: Date | null;
}

const COLUMNS = `id, product_id, sku, amount_minor, currency, customer_ref, status,
                 created_at, updated_at, paid_at, delivered_at`;

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    amountMinor: row.amount_minor,
    currency: row.currency,
    customerRef: row.customer_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
  };
}

export class PgOrderRepository implements OrderRepository {
  async insert(tx: TransactionScope, order: Order): Promise<void> {
    await tx.query(
      `INSERT INTO orders (id, product_id, sku, amount_minor, currency, customer_ref, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [order.id, order.productId, order.sku, order.amountMinor, order.currency, order.customerRef, order.status],
    );
  }

  async findById(exec: Executor, orderId: string): Promise<Order | null> {
    const result = await exec.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [orderId]);
    const row = result.rows[0];
    return row ? toOrder(row) : null;
  }

  /**
   * Takes the row lock before anything else in a write path.
   *
   * Concurrent handlers of the same order therefore queue here in a defined
   * order instead of interleaving their reads and writes. The lock is held only
   * for the duration of the transaction, and no supplier call ever happens
   * inside one, so it cannot be held across a network timeout.
   */
  async lockById(tx: TransactionScope, orderId: string): Promise<Order | null> {
    const result = await tx.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const row = result.rows[0];
    return row ? toOrder(row) : null;
  }

  /**
   * The conditional status transition.
   *
   * The expected status is part of the WHERE clause, so the database decides who
   * wins. A false return is not an error: it means another transaction already
   * moved this order, and the loser must do nothing rather than retry.
   */
  async transition(
    tx: TransactionScope,
    orderId: string,
    from: OrderStatus | readonly OrderStatus[],
    to: OrderStatus,
  ): Promise<boolean> {
    const expected = Array.isArray(from) ? from : [from as OrderStatus];
    const result = await tx.query(
      `UPDATE orders
          SET status = $3,
              updated_at = now(),
              paid_at = CASE WHEN $3 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END,
              delivered_at = CASE WHEN $3 = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END
        WHERE id = $1 AND status = ANY($2::text[])`,
      [orderId, expected, to],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Paid orders that have not reached a final state within the deadline.
   *
   * Backed by the partial index on non final statuses, so the scan is bounded by
   * the size of the backlog rather than by total order history.
   */
  async findStuck(exec: Executor, olderThan: Date, limit: number): Promise<readonly Order[]> {
    const result = await exec.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders
        WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
          AND updated_at < $1
        ORDER BY updated_at
        LIMIT $2`,
      [olderThan, limit],
    );
    return result.rows.map(toOrder);
  }
}
