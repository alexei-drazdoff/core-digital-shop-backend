/**
 * The append-only history.
 *
 * A port rather than a helper because of the transaction requirement: facts have
 * to be appended inside the same transaction as the state change they describe,
 * exactly as jobs are enqueued inside the transaction that justifies them. A
 * history written alongside, on a best-effort basis, drifts from the rows it
 * claims to explain — and a drifting history is worse than no history, because
 * it still looks authoritative.
 */
import type { Executor } from '../../infrastructure/db/pool.js';
import type { TransactionScope } from '../../infrastructure/db/unit-of-work.js';
import type { OrderEvent, OrderEventType } from '../../domain/order/projection.js';

export interface AppendOrderEvent {
  readonly orderId: string;
  readonly orderItemId?: string | null;
  readonly type: OrderEventType;
  readonly payload?: Record<string, unknown>;
  /**
   * When the fact happened in the world, if that differs from when we learned
   * it. Left unset for facts we cause ourselves, where the two are the same.
   */
  readonly occurredAt?: Date | null;
}

export interface PeriodTotals {
  readonly from: Date;
  readonly to: Date;
  readonly byAccount: ReadonlyArray<{ account: string; signedMinor: number }>;
  readonly capturedMinor: number;
  readonly refundedMinor: number;
  readonly netRevenueMinor: number;
  readonly cashMovementMinor: number;
  readonly ordersPaid: number;
  readonly itemsDelivered: number;
  readonly itemsRefunded: number;
  /** Cash movement must equal captured minus refunded. Two sums, one truth. */
  readonly balanced: boolean;
}

export interface OrderEventRepository {
  append(tx: TransactionScope, events: readonly AppendOrderEvent[]): Promise<void>;
  /** The whole history of one order, oldest first, for the as-of fold. */
  findByOrder(exec: Executor, orderId: string): Promise<readonly OrderEvent[]>;
  periodTotals(exec: Executor, from: Date, to: Date): Promise<PeriodTotals>;
}
