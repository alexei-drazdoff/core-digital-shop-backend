/**
 * Ports. The use cases speak only these interfaces, so the transactional
 * behaviour they rely on is stated here as a contract rather than left implicit
 * in whichever SQL happens to be underneath.
 */
import type { Executor } from '../../infrastructure/db/pool.js';
import type { TransactionScope } from '../../infrastructure/db/unit-of-work.js';
import type { Order, OrderItem } from '../../domain/order/order.js';
import type { OrderItemStatus, OrderStatus } from '../../domain/order/status.js';
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
  /** Writes the order and all of its lines in one statement pair, inside the caller's transaction. */
  insert(tx: TransactionScope, order: Order, items: readonly OrderItem[]): Promise<void>;
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

/**
 * The lines of a basket.
 *
 * Separate from OrderRepository because the two answer different questions and
 * are locked at different granularities: the order row is what serialises money,
 * the line row is what serialises one supplier conversation. A worker delivering
 * line 3 must not queue behind a worker delivering line 1.
 */
export interface OrderItemRepository {
  findByOrder(exec: Executor, orderId: string): Promise<readonly OrderItem[]>;
  findById(exec: Executor, orderItemId: string): Promise<OrderItem | null>;
  /** SELECT ... FOR UPDATE on the single line. */
  lockById(tx: TransactionScope, orderItemId: string): Promise<OrderItem | null>;
  /**
   * SELECT ... FOR UPDATE over every line of an order, in a fixed order.
   *
   * Settlement needs all of them at once to decide the order's fate, and taking
   * them by line_no means two concurrent settlements of the same order acquire
   * the same locks in the same sequence and cannot deadlock.
   */
  lockByOrder(tx: TransactionScope, orderId: string): Promise<readonly OrderItem[]>;
  /**
   * Conditional UPDATE guarded on the expected current status, mirroring
   * OrderRepository.transition. The database picks the winner.
   */
  transition(
    tx: TransactionScope,
    orderItemId: string,
    from: OrderItemStatus | readonly OrderItemStatus[],
    to: OrderItemStatus,
  ): Promise<boolean>;
  /** Records that one more full pass through the suppliers has been spent. */
  countRound(tx: TransactionScope, orderItemId: string): Promise<number>;
  /**
   * Returns lines abandoned in `delivering` to a claimable state.
   *
   * The line-level counterpart of JobQueue.requeueAbandoned. Without it a worker
   * that dies mid delivery leaves a line nothing can claim and nothing will
   * refund, which is a paid customer stranded forever.
   */
  releaseStaleDelivering(tx: TransactionScope, olderThan: Date, limit: number): Promise<number>;
  /**
   * Lines of paid orders that stopped moving and still have attempts left.
   *
   * Feeds the recovery sweep. `maxRounds` is passed rather than assumed so the
   * sweep never re-enqueues a line whose budget is spent: the only correct
   * action for those is a refund, and settlement owns that.
   */
  findStuck(exec: Executor, olderThan: Date, limit: number, maxRounds: number): Promise<readonly OrderItem[]>;
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
  readonly orderItemId: string;
  readonly supplier: string;
  /** Advances only when a response is rejected as invalid. See supplierRequestId. */
  readonly epoch: number;
  readonly state: SupplierRequestState;
  readonly code: string | null;
  readonly failureReason: string | null;
  readonly attempts: number;
  readonly lastSentAt: Date;
}

export interface SupplierRequestRepository {
  /** Records the intent to call a supplier BEFORE the call is made. */
  beginAttempt(
    exec: Executor,
    request: { requestId: string; orderId: string; orderItemId: string; supplier: string; epoch: number },
  ): Promise<SupplierRequestRecord>;
  settle(
    exec: Executor,
    requestId: string,
    state: SupplierRequestState,
    fields: { code?: string | null; failureReason?: string | null },
  ): Promise<void>;
  find(exec: Executor, requestId: string): Promise<SupplierRequestRecord | null>;
  findByOrder(exec: Executor, orderId: string): Promise<readonly SupplierRequestRecord[]>;
  /**
   * The highest epoch reached for (line, supplier), or 0 when nothing was ever sent.
   *
   * Delivery resumes at this epoch rather than restarting at 1, which is what
   * keeps a retry after a crash asking about the request that may already have
   * produced a code instead of opening a fresh one.
   */
  latestEpoch(exec: Executor, orderItemId: string, supplier: string): Promise<number>;
  /** Indeterminate calls the background reconciler still has to settle. */
  findUnsettled(exec: Executor, olderThan: Date, limit: number): Promise<readonly SupplierRequestRecord[]>;
  recordAttempt(
    exec: Executor,
    attempt: {
      orderId: string;
      orderItemId: string;
      supplier: string;
      requestId: string;
      attemptNo: number;
      /** `rejected` is the second stage's addition: the supplier answered, and the answer was unusable. */
      outcome: 'issued' | 'refused' | 'timeout' | 'transport_error' | 'circuit_open' | 'rejected';
      latencyMs: number | null;
      error: string | null;
    },
  ): Promise<void>;
}

export interface DeliveryRecord {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly supplier: string;
  readonly requestId: string;
  readonly code: string;
  readonly deliveredAt: Date;
}

export interface DeliveryRepository {
  /**
   * INSERT ... ON CONFLICT (order_item_id) DO NOTHING.
   *
   * The third and final exactly-once layer. A false return means this line was
   * already delivered, and the caller must treat its own code as surplus rather
   * than overwrite anything.
   */
  recordIfAbsent(tx: TransactionScope, delivery: Omit<DeliveryRecord, 'deliveredAt'>): Promise<boolean>;
  findByItem(exec: Executor, orderItemId: string): Promise<DeliveryRecord | null>;
  findByOrder(exec: Executor, orderId: string): Promise<readonly DeliveryRecord[]>;
  recordOrphan(
    tx: TransactionScope,
    orphan: {
      orderId: string;
      orderItemId: string;
      supplier: string;
      requestId: string;
      code: string;
      note: string;
    },
  ): Promise<boolean>;
}

export type CodeDisposition = 'delivered' | 'orphan' | 'quarantined';

export interface IssuedCodeRecord {
  readonly code: string;
  readonly supplier: string;
  readonly requestId: string;
  readonly orderItemId: string | null;
  readonly orderId: string | null;
  readonly disposition: CodeDisposition;
  readonly reason: string | null;
  readonly createdAt: Date;
}

/**
 * Every code the system has ever seen, keyed BY THE CODE.
 *
 * This is what answers "один код никогда не уйдёт двум покупателям" against a
 * supplier that cannot be trusted. The first stage's defences all protect
 * against an answer going missing; none of them notice an answer that arrives
 * carrying a code somebody else already owns, because that code looks perfectly
 * valid at the point of use.
 *
 * The key is the code alone and not (supplier, code): a code that supplier B
 * hands back after supplier A already sold it is exactly the case this exists to
 * catch, and scoping uniqueness per supplier would miss it.
 */
export interface IssuedCodeRepository {
  /**
   * INSERT ... ON CONFLICT (code) DO NOTHING.
   *
   * False means this code is already spoken for. Always written in the same
   * transaction as whatever was decided about the code, so the registry and the
   * decision cannot disagree.
   */
  claim(tx: TransactionScope, record: Omit<IssuedCodeRecord, 'createdAt'>): Promise<boolean>;
  /**
   * Changes what a code we already hold is FOR, never who holds it.
   *
   * A code claimed for a line that then lost the delivery race is stock consumed
   * with no sale behind it, so it becomes an orphan. The code stays ours either
   * way — that is the part that must not change, because releasing it would put
   * a code that a supplier already spent back into circulation.
   */
  reclassify(
    tx: TransactionScope,
    code: string,
    disposition: CodeDisposition,
    reason: string | null,
  ): Promise<void>;
  find(exec: Executor, code: string): Promise<IssuedCodeRecord | null>;
  /** Codes refused as invalid and never handed to anybody. Feeds the report. */
  quarantined(exec: Executor, limit: number): Promise<readonly IssuedCodeRecord[]>;
}

export interface RefundRecord {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
  readonly createdAt: Date;
}

export interface RefundRepository {
  /**
   * INSERT ... ON CONFLICT (order_item_id) DO NOTHING.
   *
   * The mirror image of DeliveryRepository.recordIfAbsent. One says a line is
   * delivered at most once, this one says it is refunded at most once, and
   * together they make double spending on either side a constraint violation
   * rather than something the retry logic has to be trusted about.
   */
  recordIfAbsent(tx: TransactionScope, refund: Omit<RefundRecord, 'createdAt'>): Promise<boolean>;
  findByOrder(exec: Executor, orderId: string): Promise<readonly RefundRecord[]>;
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
