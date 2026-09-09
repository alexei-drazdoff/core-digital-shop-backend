/**
 * Settles a supplier call whose outcome was never learned.
 *
 * This is the second half of the timeout trap. When a call timed out, the
 * delivery path failed over so the customer was not left waiting, but it also
 * left behind a row saying "this supplier may have issued a code". That claim
 * has to be resolved, or stock quietly disappears and the books stop matching.
 *
 * The resolution mechanism is the contract itself: repeating the call with the
 * SAME request id is a read, not a write. Either the supplier has a code for it,
 * in which case it returns that same code, or it does not.
 *
 * Two things can then be true:
 *
 *   the line is still undelivered, so the recovered code delivers it, which is
 *   the good case and costs the customer nothing;
 *
 *   the line was already served by the fallback, so the recovered code is stock
 *   consumed without a sale. It is recorded as an orphan and written off as
 *   shrinkage, which is what keeps the money journal balanced.
 */
import { orphanIssuanceEntries, deliveryCostEntries } from '../../domain/ledger/entries.js';
import { settlementJobDedupeKey } from './apply-payment-event.js';
import type { SupplierGateway } from '../ports/supplier-gateway.js';
import type { JobQueue } from '../ports/queue.js';
import type {
  DeliveryRepository,
  LedgerRepository,
  OrderItemRepository,
  ProductRepository,
  SupplierRequestRepository,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';
import type { DeliveryMetrics } from '../ports/metrics.js';

export type ReconcileResult =
  | { readonly kind: 'nothing_to_do'; readonly reason: string }
  /** The supplier had issued nothing. The request is now definitively closed. */
  | { readonly kind: 'closed_empty' }
  /** A code was recovered and it delivered the line. */
  | { readonly kind: 'recovered_and_delivered' }
  /** A code was recovered but the line was already served, so it is written off. */
  | { readonly kind: 'recovered_as_orphan' }
  /** Still unreachable. Left unsettled so a later run tries again. */
  | { readonly kind: 'still_unknown' };

export class ReconcileSupplierRequestUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orderItems: OrderItemRepository;
      products: ProductRepository;
      deliveries: DeliveryRepository;
      supplierRequests: SupplierRequestRepository;
      ledger: LedgerRepository;
      queue: JobQueue;
      suppliers: readonly SupplierGateway[];
      metrics: DeliveryMetrics;
      logger: Logger;
    },
  ) {}

  async execute(requestId: string): Promise<ReconcileResult> {
    const { uow, orderItems, deliveries, supplierRequests, suppliers, logger } = this.deps;

    const record = await supplierRequests.find(uow.executor, requestId);
    if (!record) return { kind: 'nothing_to_do', reason: 'request_not_found' };
    if (record.state === 'failed_definitive') return { kind: 'nothing_to_do', reason: 'already_settled' };

    const item = await orderItems.findById(uow.executor, record.orderItemId);
    if (!item) return { kind: 'nothing_to_do', reason: 'order_item_not_found' };

    // A code already known from an earlier settle still needs placing: it may
    // never have been applied if the process died right after settling.
    let code = record.state === 'succeeded' ? record.code : null;

    if (!code) {
      const gateway = suppliers.find((supplier) => supplier.name === record.supplier);
      if (!gateway) return { kind: 'nothing_to_do', reason: 'unknown_supplier' };

      const result = await gateway.issue({
        requestId,
        orderId: record.orderId,
        orderItemId: record.orderItemId,
        sku: item.sku,
      });
      await supplierRequests.recordAttempt(uow.executor, {
        orderId: record.orderId,
        orderItemId: record.orderItemId,
        supplier: record.supplier,
        requestId,
        attemptNo: record.attempts + 1,
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

      if (result.kind === 'indeterminate') {
        // Still no answer. The claim stays open on purpose, because closing it
        // would be asserting something we do not know.
        logger.warn(
          { request_id: requestId, order_item_id: record.orderItemId, supplier: record.supplier },
          'supplier still unreachable, claim left open',
        );
        return { kind: 'still_unknown' };
      }

      if (result.kind === 'refused') {
        // The supplier looked up the request id and has nothing for it. That is
        // proof no code was issued, so the claim closes with no loss.
        await supplierRequests.settle(uow.executor, requestId, 'failed_definitive', { failureReason: result.reason });
        logger.info(
          { request_id: requestId, order_item_id: record.orderItemId, supplier: record.supplier },
          'indeterminate supplier call closed, nothing had been issued',
        );
        return { kind: 'closed_empty' };
      }

      code = result.code;
      await supplierRequests.settle(uow.executor, requestId, 'succeeded', { code });
      logger.warn(
        { request_id: requestId, order_item_id: record.orderItemId, supplier: record.supplier },
        'supplier had issued a code after all, recovering it',
      );
    }

    const alreadyDelivered = await deliveries.findByItem(uow.executor, record.orderItemId);
    const outcome = alreadyDelivered
      ? await this.writeOff(record.orderItemId, record.supplier, requestId, code)
      : await this.deliverWith(record.orderItemId, record.supplier, requestId, code);

    // Either branch may have resolved the last open line of the basket, so the
    // order is asked to settle. Cheap when nothing changed: settlement re-derives
    // the same status and writes nothing.
    await this.scheduleSettlement(record.orderId);
    return outcome;
  }

  /** Places a recovered code against a line that is still waiting for one. */
  private async deliverWith(
    orderItemId: string,
    supplier: string,
    requestId: string,
    code: string,
  ): Promise<ReconcileResult> {
    const { uow, orderItems, products, deliveries, ledger, metrics, logger } = this.deps;

    return uow.withTransaction(async (tx) => {
      const item = await orderItems.lockById(tx, orderItemId);
      if (!item) return { kind: 'nothing_to_do', reason: 'order_item_not_found' } as const;

      const recorded = await deliveries.recordIfAbsent(tx, {
        orderId: item.orderId,
        orderItemId,
        supplier,
        requestId,
        code,
      });
      if (!recorded) {
        // Lost a race with the delivery worker between the check and here. The
        // unique constraint caught it, so this becomes a write off instead.
        await deliveries.recordOrphan(tx, {
          orderId: item.orderId,
          orderItemId,
          supplier,
          requestId,
          code,
          note: 'raced with the delivery worker',
        });
        await ledger.append(
          tx,
          orphanIssuanceEntries({
            orderId: item.orderId,
            orderItemId,
            costMinor: item.costMinor,
            currency: item.currency,
            requestId,
          }),
        );
        metrics.recordOrphan(supplier);
        return { kind: 'recovered_as_orphan' } as const;
      }

      await orderItems.transition(
        tx,
        orderItemId,
        ['pending', 'delivering', 'out_of_stock', 'delivery_failed'],
        'delivered',
      );
      await products.adjustStock(tx, item.productId, -1);
      await ledger.append(
        tx,
        deliveryCostEntries({
          orderId: item.orderId,
          orderItemId,
          costMinor: item.costMinor,
          currency: item.currency,
          requestId,
        }),
      );
      metrics.recordDelivery(supplier);
      logger.info(
        { order_item_id: orderItemId, supplier, request_id: requestId },
        'line delivered from a recovered supplier code',
      );
      return { kind: 'recovered_and_delivered' } as const;
    });
  }

  /** Records stock consumed for a line that was already served elsewhere. */
  private async writeOff(
    orderItemId: string,
    supplier: string,
    requestId: string,
    code: string,
  ): Promise<ReconcileResult> {
    const { uow, orderItems, deliveries, ledger, metrics, logger } = this.deps;

    return uow.withTransaction(async (tx) => {
      const item = await orderItems.lockById(tx, orderItemId);
      if (!item) return { kind: 'nothing_to_do', reason: 'order_item_not_found' } as const;

      const fresh = await deliveries.recordOrphan(tx, {
        orderId: item.orderId,
        orderItemId,
        supplier,
        requestId,
        code,
        note: 'supplier issued a code for a call that timed out, line was served by the fallback',
      });
      if (!fresh) return { kind: 'nothing_to_do', reason: 'orphan_already_recorded' } as const;

      await ledger.append(
        tx,
        orphanIssuanceEntries({
          orderId: item.orderId,
          orderItemId,
          costMinor: item.costMinor,
          currency: item.currency,
          requestId,
        }),
      );
      metrics.recordOrphan(supplier);
      logger.error(
        { order_item_id: orderItemId, supplier, request_id: requestId },
        'orphaned issuance recorded: stock consumed with no sale behind it',
      );
      return { kind: 'recovered_as_orphan' } as const;
    });
  }

  private async scheduleSettlement(orderId: string): Promise<void> {
    await this.deps.uow.withTransaction((tx) =>
      this.deps.queue.enqueue(tx, {
        kind: 'settle_order',
        dedupeKey: settlementJobDedupeKey(orderId),
        payload: { orderId },
      }),
    );
  }
}
