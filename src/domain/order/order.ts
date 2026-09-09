import { ulid } from 'ulid';
import type { OrderItemStatus, OrderStatus } from './status.js';

export interface Order {
  readonly id: string;
  /** Sum of the line prices. What the payment webhook is checked against. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly customerRef: string | null;
  readonly status: OrderStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly paidAt: Date | null;
  readonly deliveredAt: Date | null;
}

/**
 * One line of a basket, and the unit everything downstream is keyed by.
 *
 * Price and cost are captured here rather than read from the catalog at delivery
 * time: the catalog moves, what the customer paid does not, and a refund
 * computed from a later price would not match the payment it is reversing.
 */
export interface OrderItem {
  readonly id: string;
  readonly orderId: string;
  readonly lineNo: number;
  readonly productId: number;
  readonly sku: string;
  readonly priceMinor: number;
  readonly costMinor: number;
  readonly currency: string;
  readonly status: OrderItemStatus;
  /** Completed passes through every supplier. Bounded, so failure eventually refunds. */
  readonly rounds: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deliveredAt: Date | null;
  readonly refundedAt: Date | null;
}

/**
 * ULID rather than UUIDv4: it sorts by creation time, so primary key inserts
 * stay at the right edge of the btree instead of scattering random pages.
 */
export function newOrderId(): string {
  return `ord_${ulid()}`;
}

export function newOrderItemId(): string {
  return `itm_${ulid()}`;
}

/**
 * The supplier idempotency key, derived rather than generated.
 *
 * This is the single most important line in the delivery path. The supplier
 * contract guarantees that the same request_id yields the same code, so deriving
 * it from (line, supplier, epoch) and never from the attempt number means every
 * retry after a timeout re-asks about the same request instead of starting a new
 * one. A random or attempt-numbered id here would turn one timeout into two
 * issued codes.
 *
 * The epoch is what allows an escape from a request whose ANSWER is bad rather
 * than missing: a supplier that hands back a code already sold to somebody else
 * would otherwise hand back that same code forever. It advances only on that
 * rejection, never on a timeout and never on a refusal, so the timeout trap
 * keeps working exactly as it did.
 */
export function supplierRequestId(orderItemId: string, supplier: string, epoch: number): string {
  return `req_${orderItemId.replace(/^itm_/, '')}-${supplier}-${epoch}`;
}
