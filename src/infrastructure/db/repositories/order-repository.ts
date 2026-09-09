import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { Order, OrderItem } from '../../../domain/order/order.js';
import type { OrderStatus } from '../../../domain/order/status.js';
import type { OrderRepository } from '../../../application/ports/repositories.js';

interface OrderRow {
  id: string;
  amount_minor: number;
  currency: string;
  customer_ref: string | null;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  delivered_at: Date | null;
}

const COLUMNS = `id, amount_minor, currency, customer_ref, status,
                 created_at, updated_at, paid_at, delivered_at`;

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
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
  /**
   * Writes the basket as one fact.
   *
   * The lines go in with a single multi-row INSERT rather than a loop: an order
   * with no lines, or with only some of them, is not a lesser order but a
   * corrupt one, and the total in `orders.amount_minor` would already be lying
   * about what the customer is being charged for.
   */
  async insert(tx: TransactionScope, order: Order, items: readonly OrderItem[]): Promise<void> {
    await tx.query(
      `INSERT INTO orders (id, amount_minor, currency, customer_ref, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [order.id, order.amountMinor, order.currency, order.customerRef, order.status],
    );

    if (items.length === 0) return;

    await tx.query(
      `INSERT INTO order_items (id, order_id, line_no, product_id, sku, price_minor, cost_minor, currency, status)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::int[], $4::bigint[], $5::text[],
         $6::bigint[], $7::bigint[], $8::bpchar[], $9::text[]
       )`,
      [
        items.map((item) => item.id),
        items.map((item) => item.orderId),
        items.map((item) => item.lineNo),
        items.map((item) => item.productId),
        items.map((item) => item.sku),
        items.map((item) => item.priceMinor),
        items.map((item) => item.costMinor),
        items.map((item) => item.currency),
        items.map((item) => item.status),
      ],
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
              -- Set on any outcome where at least one line reached the customer,
              -- so "when did this order finish" has an answer for a partially
              -- delivered basket too.
              delivered_at = CASE WHEN $3 IN ('delivered', 'partially_delivered') AND delivered_at IS NULL
                                  THEN now() ELSE delivered_at END
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
