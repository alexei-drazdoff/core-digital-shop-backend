/**
 * Delivers one paid order.
 *
 * The whole timeout trap lives here, so the rules it follows are stated up front.
 *
 * 1. request_id is DERIVED from (order, supplier), never generated per attempt.
 *    The supplier contract promises the same request_id yields the same code,
 *    which turns every retry into a question about the original call rather than
 *    a new order for goods.
 *
 * 2. The intent to call is written BEFORE the call. A process that dies mid
 *    flight leaves a row saying a side effect may exist. Without it, a crashed
 *    delivery is indistinguishable from one that never happened.
 *
 * 3. A timeout is not a refusal. Failing over to the second supplier is allowed
 *    only after the first has definitively said no, or after its retries are
 *    exhausted, and in the latter case the unresolved call is handed to the
 *    reconciler rather than forgotten.
 *
 * 4. The database has the last word. deliveries.order_id is UNIQUE, so a code
 *    that arrives for an already delivered order becomes a recorded orphan
 *    instead of a second delivery.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { supplierRequestId } from '../../domain/order/order.js';
import { awaitsDelivery } from '../../domain/order/status.js';
import { deliveryCostEntries, orphanIssuanceEntries } from '../../domain/ledger/entries.js';
import { backoffDelayMs } from '../retry-policy.js';
import type { SupplierGateway, SupplierResult } from '../ports/supplier-gateway.js';
import type { JobQueue } from '../ports/queue.js';
import type {
  DeliveryRepository,
  LedgerRepository,
  OrderRepository,
  ProductRepository,
  SupplierRequestRepository,
} from '../ports/repositories.js';
import type { TransactionScope, UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';
import type { DeliveryMetrics } from '../ports/metrics.js';

export type DeliverOrderResult =
  | { readonly kind: 'delivered'; readonly supplier: string; readonly alreadyDelivered: boolean }
  | { readonly kind: 'out_of_stock' }
  | { readonly kind: 'failed'; readonly reason: string }
  /** Nothing to do: the order is not in a state that owes the customer a code. */
  | { readonly kind: 'not_applicable'; readonly status: string };

interface SupplierOutcome {
  readonly supplier: string;
  readonly requestId: string;
  readonly code: string | null;
  readonly refusedReason: string | null;
  readonly indeterminate: boolean;
}

export interface DeliverOrderOptions {
  readonly maxAttemptsPerSupplier: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

export class DeliverOrderUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      products: ProductRepository;
      deliveries: DeliveryRepository;
      supplierRequests: SupplierRequestRepository;
      ledger: LedgerRepository;
      queue: JobQueue;
      /** Ordered: the first is primary, the rest are fallbacks. */
      suppliers: readonly SupplierGateway[];
      options: DeliverOrderOptions;
      metrics: DeliveryMetrics;
      logger: Logger;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async execute(orderId: string): Promise<DeliverOrderResult> {
    const { uow, orders, deliveries, logger } = this.deps;

    const order = await orders.findById(uow.executor, orderId);
    if (!order) return { kind: 'not_applicable', status: 'missing' };

    // Fast path. Re-running delivery for an already delivered order is a normal
    // consequence of at-least-once job execution, not an error.
    const existing = await deliveries.findByOrder(uow.executor, orderId);
    if (existing) {
      await uow.withTransaction((tx) => orders.transition(tx, orderId, 'delivering', 'delivered'));
      return { kind: 'delivered', supplier: existing.supplier, alreadyDelivered: true };
    }

    if (!awaitsDelivery(order.status)) return { kind: 'not_applicable', status: order.status };

    // Claim the work. Losing this race means another worker holds the order, so
    // this one stops rather than calling suppliers in parallel with it.
    const claimed = await uow.withTransaction((tx) =>
      orders.transition(tx, orderId, ['paid', 'out_of_stock', 'delivery_failed'], 'delivering'),
    );
    if (!claimed) {
      const current = await orders.findById(uow.executor, orderId);
      return { kind: 'not_applicable', status: current?.status ?? 'unknown' };
    }

    const outcomes: SupplierOutcome[] = [];
    for (const supplier of this.deps.suppliers) {
      const outcome = await this.trySupplier(order.id, order.sku, supplier);
      outcomes.push(outcome);

      if (outcome.code) {
        return this.finalise(order.id, outcome, outcomes);
      }

      if (outcome.indeterminate) {
        // The supplier may have issued a code we never saw. Hand it to the
        // reconciler before moving on, so the possible orphan is chased rather
        // than lost, then fall through to the next supplier so the paying
        // customer is not left waiting on an unanswered call.
        await this.scheduleReconciliation(order.id, outcome.requestId);
        logger.warn(
          { order_id: order.id, supplier: outcome.supplier, request_id: outcome.requestId },
          'supplier outcome still unknown after retries, failing over and scheduling reconciliation',
        );
      }
    }

    return this.recordNoDelivery(order.id, outcomes);
  }

  /**
   * Calls one supplier, retrying it with the SAME request id.
   *
   * Reusing the request id is what makes the retry safe: to the supplier it is
   * the same request, so at most one code is ever issued for it however many
   * times the call is repeated.
   */
  private async trySupplier(orderId: string, sku: string, supplier: SupplierGateway): Promise<SupplierOutcome> {
    const { uow, supplierRequests, options, metrics, logger } = this.deps;
    const pause = this.deps.sleep ?? ((ms: number) => sleep(ms));
    const requestId = supplierRequestId(orderId, supplier.name);

    // A code already issued for this request id is reused rather than re-fetched:
    // asking again would be harmless under the contract, but there is nothing to
    // gain and a supplier round trip to lose.
    //
    // A past REFUSAL deliberately does not short circuit. It was definitive for
    // the attempt that got it, not forever, and treating it as permanent would
    // strand every out_of_stock order the moment stock came back.
    const known = await supplierRequests.find(uow.executor, requestId);
    if (known?.state === 'succeeded' && known.code) {
      logger.info({ order_id: orderId, supplier: supplier.name, request_id: requestId }, 'reusing code from an earlier settled call');
      return { supplier: supplier.name, requestId, code: known.code, refusedReason: null, indeterminate: false };
    }

    let lastIndeterminate = false;
    let refusedReason: string | null = null;

    for (let attempt = 1; attempt <= options.maxAttemptsPerSupplier; attempt += 1) {
      // Rule 2: the intent is durable before the side effect is possible.
      const record = await supplierRequests.beginAttempt(uow.executor, requestId, orderId, supplier.name);

      const result: SupplierResult = await supplier.issue({ requestId, orderId, sku });
      await supplierRequests.recordAttempt(uow.executor, {
        orderId,
        supplier: supplier.name,
        requestId,
        attemptNo: record.attempts,
        outcome:
          result.kind === 'issued'
            ? 'issued'
            : result.kind === 'refused'
              ? 'refused'
              : result.reason === 'circuit_open'
                ? 'circuit_open'
                : result.reason,
        latencyMs: result.latencyMs,
        error: result.kind === 'issued' ? null : result.kind === 'refused' ? result.reason : result.detail,
      });
      metrics.recordSupplierCall(supplier.name, result.kind, result.latencyMs);

      if (result.kind === 'issued') {
        await supplierRequests.settle(uow.executor, requestId, 'succeeded', { code: result.code });
        return { supplier: supplier.name, requestId, code: result.code, refusedReason: null, indeterminate: false };
      }

      if (result.kind === 'refused') {
        // The supplier answered. Nothing was issued, so there is nothing to
        // reconcile and the fallback can be tried immediately.
        await supplierRequests.settle(uow.executor, requestId, 'failed_definitive', { failureReason: result.reason });
        return { supplier: supplier.name, requestId, code: null, refusedReason: result.reason, indeterminate: false };
      }

      // Indeterminate. Record it as such and ask the same question again.
      lastIndeterminate = true;
      refusedReason = result.reason;
      await supplierRequests.settle(uow.executor, requestId, 'unknown', { failureReason: result.detail });
      metrics.recordRetry(supplier.name);

      if (attempt < options.maxAttemptsPerSupplier) {
        await pause(backoffDelayMs(attempt, { baseMs: options.backoffBaseMs, maxMs: options.backoffMaxMs }));
      }
    }

    return { supplier: supplier.name, requestId, code: null, refusedReason, indeterminate: lastIndeterminate };
  }

  /**
   * Writes the delivery, or records an orphan if the order was already served.
   *
   * Everything here is one transaction: the delivery row, the order status, the
   * stock counter and the money journal move together or not at all.
   */
  private async finalise(
    orderId: string,
    winner: SupplierOutcome,
    outcomes: readonly SupplierOutcome[],
  ): Promise<DeliverOrderResult> {
    const { uow, orders, products, deliveries, ledger, metrics, logger } = this.deps;
    const code = winner.code;
    if (!code) throw new Error('finalise called without a code');

    return uow.withTransaction(async (tx) => {
      const order = await orders.lockById(tx, orderId);
      if (!order) throw new Error(`order ${orderId} vanished during delivery`);

      // Layer 3. The database decides whether this is the delivery or a surplus code.
      const recorded = await deliveries.recordIfAbsent(tx, {
        orderId,
        supplier: winner.supplier,
        requestId: winner.requestId,
        code,
      });

      if (!recorded) {
        // Someone else already delivered this order. Our code is real stock that
        // was consumed with no sale behind it, so it is written off rather than
        // handed over or silently dropped.
        await deliveries.recordOrphan(tx, {
          orderId,
          supplier: winner.supplier,
          requestId: winner.requestId,
          code,
          note: 'order was already delivered when this code arrived',
        });
        await ledger.append(
          tx,
          orphanIssuanceEntries({
            orderId,
            costMinor: await this.costOf(tx, order.productId),
            currency: order.currency,
            requestId: winner.requestId,
          }),
        );
        metrics.recordOrphan(winner.supplier);
        logger.error(
          { order_id: orderId, supplier: winner.supplier, request_id: winner.requestId },
          'code arrived for an already delivered order, written off as shrinkage',
        );
        return { kind: 'delivered', supplier: winner.supplier, alreadyDelivered: true } as const;
      }

      await orders.transition(tx, orderId, 'delivering', 'delivered');
      await products.adjustStock(tx, order.productId, -1);
      await ledger.append(
        tx,
        deliveryCostEntries({
          orderId,
          costMinor: await this.costOf(tx, order.productId),
          currency: order.currency,
          requestId: winner.requestId,
        }),
      );

      metrics.recordDelivery(winner.supplier);
      logger.info(
        {
          order_id: orderId,
          supplier: winner.supplier,
          request_id: winner.requestId,
          suppliers_tried: outcomes.map((outcome) => outcome.supplier),
        },
        'order delivered',
      );
      return { kind: 'delivered', supplier: winner.supplier, alreadyDelivered: false } as const;
    });
  }

  /**
   * No supplier produced a code.
   *
   * The distinction matters: out_of_stock says the goods are missing and the
   * order resumes as soon as stock returns, delivery_failed says the suppliers
   * are unwell and it resumes when they recover. Both are recoverable, and
   * neither loses the customer's money.
   */
  private async recordNoDelivery(
    orderId: string,
    outcomes: readonly SupplierOutcome[],
  ): Promise<DeliverOrderResult> {
    const { uow, orders, logger } = this.deps;
    const everyRefusalIsStock =
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome.refusedReason === 'out_of_stock') &&
      !outcomes.some((outcome) => outcome.indeterminate);

    const nextStatus = everyRefusalIsStock ? 'out_of_stock' : 'delivery_failed';
    await uow.withTransaction((tx) => orders.transition(tx, orderId, 'delivering', nextStatus));

    logger.warn(
      {
        order_id: orderId,
        status: nextStatus,
        outcomes: outcomes.map((outcome) => ({
          supplier: outcome.supplier,
          reason: outcome.refusedReason,
          indeterminate: outcome.indeterminate,
        })),
      },
      'delivery did not produce a code, order left in a recoverable state',
    );

    return everyRefusalIsStock
      ? { kind: 'out_of_stock' }
      : { kind: 'failed', reason: outcomes.map((outcome) => `${outcome.supplier}:${outcome.refusedReason ?? 'unknown'}`).join(',') };
  }

  private async scheduleReconciliation(orderId: string, requestId: string): Promise<void> {
    await this.deps.uow.withTransaction((tx) =>
      this.deps.queue.enqueue(tx, {
        kind: 'reconcile_supplier_request',
        dedupeKey: `reconcile:${requestId}`,
        payload: { orderId, requestId },
        runAfter: new Date(Date.now() + 1_000),
      }),
    );
  }

  /** Supplier cost for the product, read through the port so no SQL leaks into this layer. */
  private async costOf(tx: TransactionScope, productId: number): Promise<number> {
    const product = await this.deps.products.findById(tx, productId);
    return product?.costMinor ?? 0;
  }
}
