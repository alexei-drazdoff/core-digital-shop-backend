/**
 * Ports. The use cases speak only these interfaces, so the transactional
 * behaviour they rely on is stated here as a contract rather than left implicit
 * in whichever SQL happens to be underneath.
 */
import type { Executor } from '../../infrastructure/db/pool.js';
import type { TransactionScope } from '../../infrastructure/db/unit-of-work.js';
import type { Order } from '../../domain/order/order.js';
import type { OrderStatus } from '../../domain/order/status.js';
import type { LedgerEntry } from '../../domain/ledger/entries.js';

export interface Product {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly type: string;
  readonly priceMinor: number;
  readonly costMinor: number;
  readonly currency: string;
  readonly image: string | null;
  readonly isActive: boolean;
}

export interface StorefrontItem extends Product {
  readonly availableCount: number;
  readonly sortRank: number;
}

export interface StorefrontQuery {
  readonly type?: string | undefined;
  readonly limit: number;
  /** Keyset cursor. Paging is by (sort_rank, id), never by OFFSET. */
  readonly cursor?: { readonly sortRank: number; readonly id: number } | undefined;
  readonly inStockOnly: boolean;
}

export interface ProductRepository {
  findBySku(exec: Executor, sku: string): Promise<Product | null>;
  findById(exec: Executor, productId: number): Promise<Product | null>;
  listActive(exec: Executor): Promise<readonly Product[]>;
  availableCount(exec: Executor, productId: number): Promise<number>;
  storefront(exec: Executor, query: StorefrontQuery): Promise<readonly StorefrontItem[]>;
  /**
   * Applies a delta to the availability counter and keeps products.in_stock in
   * step. The flag is only written when it actually flips, so the read-mostly
   * catalog table is not dirtied by every sale.
   */
  adjustStock(tx: TransactionScope, productId: number, delta: number): Promise<void>;
  setStock(tx: TransactionScope, productId: number, available: number): Promise<void>;
}

export interface OrderRepository {
  insert(tx: TransactionScope, order: Order): Promise<void>;
  findById(exec: Executor, orderId: string): Promise<Order | null>;
  /** SELECT ... FOR UPDATE. Serialises concurrent handlers of the same order. */
  lockById(tx: TransactionScope, orderId: string): Promise<Order | null>;
  /**
   * Conditional UPDATE guarded on the expected current status.
   *
   * Returns true only for the caller whose expectation actually matched a row,
   * which is how concurrent handlers agree on a single winner without anyone
   * holding a lock across an HTTP call.
   */
  transition(
    tx: TransactionScope,
    orderId: string,
    from: OrderStatus | readonly OrderStatus[],
    to: OrderStatus,
  ): Promise<boolean>;
  findStuck(exec: Executor, olderThan: Date, limit: number): Promise<readonly Order[]>;
}

export interface IncomingPaymentEvent {
  readonly eventId: string;
  readonly orderId: string;
  readonly status: 'paid' | 'failed';
  readonly amountMinor: number;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export type PaymentEventOutcome =
  | 'applied'
  | 'deferred'
  | 'ignored_stale'
  | 'ignored_terminal'
  | 'amount_mismatch';

export interface PaymentEventRepository {
  /**
   * INSERT ... ON CONFLICT (event_id) DO NOTHING.
   *
   * Returns true for exactly one caller when the same event is delivered many
   * times at once. This is the first of the three exactly-once layers.
   */
  claim(tx: TransactionScope, event: IncomingPaymentEvent): Promise<boolean>;
  markProcessed(tx: TransactionScope, eventId: string, outcome: PaymentEventOutcome): Promise<void>;
  /**
   * Parks an event whose order does not exist yet.
   *
   * Deliberately separate from markProcessed: parking must leave processed_at
   * NULL, because that is precisely what identifies an event still waiting to be
   * replayed. Setting it would file the event as handled and strand the order.
   */
  markDeferred(tx: TransactionScope, eventId: string): Promise<void>;
  /**
   * Locks a stored event that is still unprocessed.
   *
   * Used to replay an event that was parked before its order existed. Returns
   * null once someone else has processed it, so a replay can never apply twice.
   */
  lockIfDeferred(tx: TransactionScope, eventId: string): Promise<IncomingPaymentEvent | null>;
  /** Events that arrived before their order existed and are still waiting. */
  findDeferred(exec: Executor, orderId: string): Promise<readonly IncomingPaymentEvent[]>;
  findAnyDeferred(exec: Executor, limit: number): Promise<readonly IncomingPaymentEvent[]>;
}

export type SupplierRequestState = 'in_flight' | 'succeeded' | 'failed_definitive' | 'unknown';

export interface SupplierRequestRecord {
  readonly requestId: string;
  readonly orderId: string;
  readonly supplier: string;
  readonly state: SupplierRequestState;
  readonly code: string | null;
  readonly failureReason: string | null;
  readonly attempts: number;
  readonly lastSentAt: Date;
}

export interface SupplierRequestRepository {
  /** Records the intent to call a supplier BEFORE the call is made. */
  beginAttempt(exec: Executor, requestId: string, orderId: string, supplier: string): Promise<SupplierRequestRecord>;
  settle(
    exec: Executor,
    requestId: string,
    state: SupplierRequestState,
    fields: { code?: string | null; failureReason?: string | null },
  ): Promise<void>;
  find(exec: Executor, requestId: string): Promise<SupplierRequestRecord | null>;
  findByOrder(exec: Executor, orderId: string): Promise<readonly SupplierRequestRecord[]>;
  /** Indeterminate calls the background reconciler still has to settle. */
  findUnsettled(exec: Executor, olderThan: Date, limit: number): Promise<readonly SupplierRequestRecord[]>;
  recordAttempt(
    exec: Executor,
    attempt: {
      orderId: string;
      supplier: string;
      requestId: string;
      attemptNo: number;
      outcome: 'issued' | 'refused' | 'timeout' | 'transport_error' | 'circuit_open';
      latencyMs: number | null;
      error: string | null;
    },
  ): Promise<void>;
}

export interface DeliveryRecord {
  readonly orderId: string;
  readonly supplier: string;
  readonly requestId: string;
  readonly code: string;
  readonly deliveredAt: Date;
}

export interface DeliveryRepository {
  /**
   * INSERT ... ON CONFLICT (order_id) DO NOTHING.
   *
   * The third and final exactly-once layer. A false return means this order was
   * already delivered, and the caller must treat its own code as surplus rather
   * than overwrite anything.
   */
  recordIfAbsent(tx: TransactionScope, delivery: Omit<DeliveryRecord, 'deliveredAt'>): Promise<boolean>;
  findByOrder(exec: Executor, orderId: string): Promise<DeliveryRecord | null>;
  recordOrphan(
    tx: TransactionScope,
    orphan: { orderId: string; supplier: string; requestId: string; code: string; note: string },
  ): Promise<boolean>;
}

export interface LedgerRepository {
  /** Idempotent by (ref_type, ref_id, account, direction); replaying a fact adds nothing. */
  append(tx: TransactionScope, entries: readonly LedgerEntry[]): Promise<void>;
  balanceByAccount(exec: Executor): Promise<ReadonlyArray<{ account: string; signedMinor: number }>>;
  unbalancedGroups(exec: Executor): Promise<ReadonlyArray<{ groupId: string; signedMinor: number }>>;
}

export interface IdempotencyRepository {
  find(exec: Executor, key: string): Promise<{ requestHash: string; status: number; body: unknown } | null>;
  save(
    tx: TransactionScope,
    record: { key: string; requestHash: string; status: number; body: unknown },
  ): Promise<boolean>;
}
