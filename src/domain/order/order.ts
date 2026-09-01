import { ulid } from 'ulid';
import type { OrderStatus } from './status.js';

export interface Order {
  readonly id: string;
  readonly productId: number;
  readonly sku: string;
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
 * ULID rather than UUIDv4: it sorts by creation time, so primary key inserts
 * stay at the right edge of the btree instead of scattering random pages.
 */
export function newOrderId(): string {
  return `ord_${ulid()}`;
}

/**
 * The supplier idempotency key, derived rather than generated.
 *
 * This is the single most important line in the delivery path. The supplier
 * contract guarantees that the same request_id yields the same code, so deriving
 * it from (order, supplier) and never from the attempt number means every retry
 * after a timeout re-asks about the same request instead of starting a new one.
 * A random or attempt-numbered id here would turn one timeout into two issued codes.
 */
export function supplierRequestId(orderId: string, supplier: string): string {
  return `req_${orderId.replace(/^ord_/, '')}-${supplier}`;
}
