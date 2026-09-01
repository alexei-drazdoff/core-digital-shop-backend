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
 *   the order is still undelivered, so the recovered code delivers it, which is
 *   the good case and costs the customer nothing;
 *
 *   the order was already delivered by the fallback, so the recovered code is
 *   stock consumed without a sale. It is recorded as an orphan and written off
 *   as shrinkage, which is what keeps the money journal balanced.
 */
import { orphanIssuanceEntries, deliveryCostEntries } from '../../domain/ledger/entries.js';
import type { SupplierGateway } from '../ports/supplier-gateway.js';
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

export type ReconcileResult =
  | { readonly kind: 'nothing_to_do'; readonly reason: string }
  /** The supplier had issued nothing. The request is now definitively closed. */
  | { readonly kind: 'closed_empty' }
  /** A code was recovered and it delivered the order. */
  | { readonly kind: 'recovered_and_delivered' }
  /** A code was recovered but the order was already served, so it is written off. */
  | { readonly kind: 'recovered_as_orphan' }
  /** Still unreachable. Left unsettled so a later run tries again. */
  | { readonly kind: 'still_unknown' };

export class ReconcileSupplierRequestUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      products: ProductRepository;
      deliveries: DeliveryRepository;
      supplierRequests: SupplierRequestRepository;
      ledger: LedgerRepository;
      suppliers: readonly SupplierGateway[];
      metrics: DeliveryMetrics;
      logger: Logger;
    },
  ) {}

  async execute(requestId: string): Promise<ReconcileResult> {
    const { uow, orders, deliveries, supplierRequests, suppliers, logger } = this.deps;

    const record = await supplierRequests.find(uow.executor, requestId);
    if (!record) return { kind: 'nothing_to_do', reason: 'request_not_found' };
    if (record.state === 'failed_definitive') return { kind: 'nothing_to_do', reason: 'already_settled' };

    const order = await orders.findById(uow.executor, record.orderId);
    if (!order) return { kind: 'nothing_to_do', reason: 'order_not_found' };

    // A code already known from an earlier settle still needs placing: it may
    // never have been applied if the process died right after settling.
    let code = record.state === 'succeeded' ? record.code : null;

    if (!code) {
      const gateway = suppliers.find((supplier) => supplier.name === record.supplier);
      if (!gateway) return { kind: 'nothing_to_do', reason: 'unknown_supplier' };

      const result = await gateway.issue({ requestId, orderId: record.orderId, sku: order.sku });
      await supplierRequests.recordAttempt(uow.executor, {
        orderId: record.orderId,
        supplier: record.supplier,
        requestId,
        attemptNo: record.attempts + 1,
        outcome: result.kind === 'issued' ? 'issued' : result.kind === 'refused' ? 'refused' : result.reason === 'circuit_open' ? 'circuit_open' : result.reason,
        latencyMs: result.latencyMs,
        error: result.kind === 'issued' ? null : result.kind === 'refused' ? result.reason : result.detail,
      });

      if (result.kind === 'indeterminate') {
        // Still no answer. The claim stays open on purpose, because closing it
        // would be asserting something we do not know.
        logger.warn({ request_id: requestId, order_id: record.orderId, supplier: record.supplier }, 'supplier still unreachable, claim left open');
        return { kind: 'still_unknown' };
      }

      if (result.kind === 'refused') {
        // The supplier looked up the request id and has nothing for it. That is
        // proof no code was issued, so the claim closes with no loss.
        await supplierRequests.settle(uow.executor, requestId, 'failed_definitive', { failureReason: result.reason });
        logger.info({ request_id: requestId, order_id: record.orderId, supplier: record.supplier }, 'indeterminate supplier call closed, nothing had been issued');
        return { kind: 'closed_empty' };
      }

      code = result.code;
      await supplierRequests.settle(uow.executor, requestId, 'succeeded', { code });
      logger.warn(
        { request_id: requestId, order_id: record.orderId, supplier: record.supplier },
        'supplier had issued a code after all, recovering it',
      );
    }

    const alreadyDelivered = await deliveries.findByOrder(uow.executor, record.orderId);
    return alreadyDelivered ? this.writeOff(record.orderId, record.supplier, requestId, code) : this.deliverWith(record.orderId, record.supplier, requestId, code);
  }

  /** Places a recovered code against an order that is still waiting for one. */
  private async deliverWith(orderId: string, supplier: string, requestId: string, code: string): Promise<ReconcileResult> {
    const { uow, orders, products, deliveries, ledger, metrics, logger } = this.deps;

    return uow.withTransaction(async (tx) => {
      const order = await orders.lockById(tx, orderId);
      if (!order) return { kind: 'nothing_to_do', reason: 'order_not_found' } as const;

      const recorded = await deliveries.recordIfAbsent(tx, { orderId, supplier, requestId, code });
      if (!recorded) {
        // Lost a race with the delivery worker between the check and here. The
        // unique constraint caught it, so this becomes a write off instead.
        await deliveries.recordOrphan(tx, { orderId, supplier, requestId, code, note: 'raced with the delivery worker' });
        await ledger.append(
          tx,
          orphanIssuanceEntries({ orderId, costMinor: await this.costOf(tx, order.productId), currency: order.currency, requestId }),
        );
        metrics.recordOrphan(supplier);
        return { kind: 'recovered_as_orphan' } as const;
      }

      await orders.transition(tx, orderId, ['paid', 'delivering', 'out_of_stock', 'delivery_failed'], 'delivered');
      await products.adjustStock(tx, order.productId, -1);
      await ledger.append(
        tx,
        deliveryCostEntries({ orderId, costMinor: await this.costOf(tx, order.productId), currency: order.currency, requestId }),
      );
      metrics.recordDelivery(supplier);
      logger.info({ order_id: orderId, supplier, request_id: requestId }, 'order delivered from a recovered supplier code');
      return { kind: 'recovered_and_delivered' } as const;
    });
  }

  /** Records stock consumed for an order that was already served elsewhere. */
  private async writeOff(orderId: string, supplier: string, requestId: string, code: string): Promise<ReconcileResult> {
    const { uow, orders, deliveries, ledger, metrics, logger } = this.deps;

    return uow.withTransaction(async (tx) => {
      const order = await orders.lockById(tx, orderId);
      if (!order) return { kind: 'nothing_to_do', reason: 'order_not_found' } as const;

      const fresh = await deliveries.recordOrphan(tx, {
        orderId,
        supplier,
        requestId,
        code,
        note: 'supplier issued a code for a call that timed out, order was served by the fallback',
      });
      if (!fresh) return { kind: 'nothing_to_do', reason: 'orphan_already_recorded' } as const;

      await ledger.append(
        tx,
        orphanIssuanceEntries({ orderId, costMinor: await this.costOf(tx, order.productId), currency: order.currency, requestId }),
      );
      metrics.recordOrphan(supplier);
      logger.error(
        { order_id: orderId, supplier, request_id: requestId },
        'orphaned issuance recorded: stock consumed with no sale behind it',
      );
      return { kind: 'recovered_as_orphan' } as const;
    });
  }

  private async costOf(tx: TransactionScope, productId: number): Promise<number> {
    const product = await this.deps.products.findById(tx, productId);
    return product?.costMinor ?? 0;
  }
}
