/**
 * Composition root.
 *
 * Everything is constructed here, by hand, in one readable place. No decorators,
 * no reflection, no runtime container: the dependency graph of a system whose
 * correctness rests on transaction boundaries should be something a reviewer can
 * read top to bottom in one sitting.
 */
import { loadConfig, type AppConfig } from '../infrastructure/config/env.js';
import { createPool, type Pool } from '../infrastructure/db/pool.js';
import { createUnitOfWork, type UnitOfWork } from '../infrastructure/db/unit-of-work.js';
import { createLogger, type Logger } from '../infrastructure/observability/logger.js';
import { createMetrics, type AppMetrics } from '../infrastructure/observability/metrics.js';

import { PgProductRepository } from '../infrastructure/db/repositories/product-repository.js';
import { PgOrderRepository } from '../infrastructure/db/repositories/order-repository.js';
import { PgOrderItemRepository } from '../infrastructure/db/repositories/order-item-repository.js';
import { PgPaymentEventRepository } from '../infrastructure/db/repositories/payment-event-repository.js';
import { PgDeliveryRepository, PgSupplierRequestRepository } from '../infrastructure/db/repositories/delivery-repository.js';
import { PgIssuedCodeRepository } from '../infrastructure/db/repositories/issued-code-repository.js';
import { PgRefundRepository } from '../infrastructure/db/repositories/refund-repository.js';
import { PgLedgerRepository } from '../infrastructure/db/repositories/ledger-repository.js';
import { PgIdempotencyRepository } from '../infrastructure/db/repositories/idempotency-repository.js';
import { PgReconciliationRepository } from '../infrastructure/db/repositories/reconciliation-repository.js';
import { PgJobQueue } from '../infrastructure/queue/pg-job-queue.js';
import { CircuitBreaker } from '../infrastructure/suppliers/circuit-breaker.js';
import { HttpSupplierGateway } from '../infrastructure/suppliers/http-supplier-gateway.js';
import { PgSupplierRateLimiter } from '../infrastructure/suppliers/pg-rate-limiter.js';

import { systemClock, type Clock } from '../application/ports/clock.js';
import type { SupplierGateway } from '../application/ports/supplier-gateway.js';
import { CreateOrderUseCase } from '../application/use-cases/create-order.js';
import { ApplyPaymentEventUseCase } from '../application/use-cases/apply-payment-event.js';
import { DeliverOrderItemUseCase } from '../application/use-cases/deliver-order-item.js';
import { SettleOrderUseCase } from '../application/use-cases/settle-order.js';
import { ReconcileSupplierRequestUseCase } from '../application/use-cases/reconcile-supplier-request.js';
import { RecoverStuckOrdersUseCase } from '../application/use-cases/recover-stuck-orders.js';
import { SweepSupplierDiscrepanciesUseCase } from '../application/use-cases/sweep-supplier-discrepancies.js';
import { SyncStockUseCase } from '../application/use-cases/sync-stock.js';
import { SUPPLIER_A, SUPPLIER_B } from '../shared/constants.js';

export interface Container {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly uow: UnitOfWork;
  readonly logger: Logger;
  readonly metrics: AppMetrics;
  readonly clock: Clock;
  readonly suppliers: readonly SupplierGateway[];
  readonly repositories: {
    products: PgProductRepository;
    orders: PgOrderRepository;
    orderItems: PgOrderItemRepository;
    paymentEvents: PgPaymentEventRepository;
    deliveries: PgDeliveryRepository;
    supplierRequests: PgSupplierRequestRepository;
    issuedCodes: PgIssuedCodeRepository;
    refunds: PgRefundRepository;
    ledger: PgLedgerRepository;
    idempotency: PgIdempotencyRepository;
    reconciliation: PgReconciliationRepository;
  };
  readonly queue: PgJobQueue;
  readonly rateLimiter: PgSupplierRateLimiter;
  readonly useCases: {
    createOrder: CreateOrderUseCase;
    applyPaymentEvent: ApplyPaymentEventUseCase;
    deliverOrderItem: DeliverOrderItemUseCase;
    settleOrder: SettleOrderUseCase;
    reconcileSupplierRequest: ReconcileSupplierRequestUseCase;
    recoverStuckOrders: RecoverStuckOrdersUseCase;
    sweepSupplierDiscrepancies: SweepSupplierDiscrepanciesUseCase;
    syncStock: SyncStockUseCase;
  };
  shutdown(): Promise<void>;
}

export interface BuildContainerOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  /** Substituted in tests so supplier behaviour is deterministic and offline. */
  readonly suppliers?: readonly SupplierGateway[];
  readonly clock?: Clock;
}

export function buildContainer(options: BuildContainerOptions = {}): Container {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const metrics = createMetrics();
  const pool = createPool(config);
  const uow = createUnitOfWork(pool);
  const clock = options.clock ?? systemClock;

  const products = new PgProductRepository();
  const orders = new PgOrderRepository();
  const orderItems = new PgOrderItemRepository();
  const paymentEvents = new PgPaymentEventRepository();
  const deliveries = new PgDeliveryRepository();
  const supplierRequests = new PgSupplierRequestRepository();
  const issuedCodes = new PgIssuedCodeRepository();
  const refunds = new PgRefundRepository();
  const ledger = new PgLedgerRepository();
  const idempotency = new PgIdempotencyRepository();
  const reconciliation = new PgReconciliationRepository(pool, ledger);
  const queue = new PgJobQueue();
  const rateLimiter = new PgSupplierRateLimiter();

  // Order matters: the first supplier is primary and the rest are fallbacks.
  const suppliers: readonly SupplierGateway[] =
    options.suppliers ??
    [
      { name: SUPPLIER_A, baseUrl: config.SUPPLIER_A_URL },
      { name: SUPPLIER_B, baseUrl: config.SUPPLIER_B_URL },
    ].map(
      (supplier) =>
        new HttpSupplierGateway({
          name: supplier.name,
          baseUrl: supplier.baseUrl,
          timeoutMs: config.SUPPLIER_TIMEOUT_MS,
          // One breaker per supplier: a dead primary must not trip the fallback.
          breaker: new CircuitBreaker(supplier.name, {
            failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD,
            openMs: config.CIRCUIT_OPEN_MS,
          }),
          logger,
        }),
    );

  const applyPaymentEvent = new ApplyPaymentEventUseCase({
    uow,
    orders,
    orderItems,
    paymentEvents,
    ledger,
    queue,
    logger,
  });

  const createOrder = new CreateOrderUseCase({
    uow,
    products,
    orders,
    orderItems,
    paymentEvents,
    idempotency,
    applyPaymentEvent,
    clock,
    logger,
  });

  const deliverOrderItem = new DeliverOrderItemUseCase({
    uow,
    orders,
    orderItems,
    products,
    deliveries,
    supplierRequests,
    issuedCodes,
    ledger,
    queue,
    rateLimiter,
    suppliers,
    metrics,
    logger,
    options: {
      maxAttemptsPerSupplier: config.SUPPLIER_MAX_ATTEMPTS,
      backoffBaseMs: config.SUPPLIER_BACKOFF_BASE_MS,
      backoffMaxMs: config.SUPPLIER_BACKOFF_MAX_MS,
      maxEpochsPerSupplier: config.SUPPLIER_MAX_EPOCHS,
    },
  });

  const settleOrder = new SettleOrderUseCase({
    uow,
    orders,
    orderItems,
    refunds,
    ledger,
    logger,
    options: { maxDeliveryRounds: config.ITEM_MAX_DELIVERY_ROUNDS },
  });

  const reconcileSupplierRequest = new ReconcileSupplierRequestUseCase({
    uow,
    orderItems,
    products,
    deliveries,
    supplierRequests,
    issuedCodes,
    ledger,
    queue,
    rateLimiter,
    suppliers,
    metrics,
    logger,
  });

  const recoverStuckOrders = new RecoverStuckOrdersUseCase({
    uow,
    orders,
    orderItems,
    paymentEvents,
    queue,
    clock,
    logger,
    stuckAfterMs: config.STUCK_ORDER_AFTER_MS,
    maxDeliveryRounds: config.ITEM_MAX_DELIVERY_ROUNDS,
  });

  const sweepSupplierDiscrepancies = new SweepSupplierDiscrepanciesUseCase({
    uow,
    supplierRequests,
    queue,
    clock,
    logger,
    staleAfterMs: config.STUCK_ORDER_AFTER_MS,
  });

  const syncStock = new SyncStockUseCase({ uow, products, suppliers, logger });

  return {
    config,
    pool,
    uow,
    logger,
    metrics,
    clock,
    suppliers,
    repositories: {
      products,
      orders,
      orderItems,
      paymentEvents,
      deliveries,
      supplierRequests,
      issuedCodes,
      refunds,
      ledger,
      idempotency,
      reconciliation,
    },
    queue,
    rateLimiter,
    useCases: {
      createOrder,
      applyPaymentEvent,
      deliverOrderItem,
      settleOrder,
      reconcileSupplierRequest,
      recoverStuckOrders,
      sweepSupplierDiscrepancies,
      syncStock,
    },
    async shutdown() {
      await pool.end();
    },
  };
}
