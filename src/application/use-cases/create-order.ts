import { createHash } from 'node:crypto';
import { newOrderId, type Order } from '../../domain/order/order.js';
import { ProductInactiveError, ProductNotFoundError, IdempotencyConflictError } from '../../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type {
  IdempotencyRepository,
  OrderRepository,
  PaymentEventRepository,
  ProductRepository,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';
import type { ApplyPaymentEventUseCase } from './apply-payment-event.js';

export interface CreateOrderInput {
  readonly sku: string;
  readonly customerRef?: string | null;
  /**
   * Optional client supplied id.
   *
   * Allowing the caller to name the order is what makes the out of order webhook
   * case reachable in practice: the payment side can be told the id before our
   * row exists. It is validated at the HTTP boundary.
   */
  readonly orderId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface CreateOrderResult {
  readonly order: Order;
  /** True when an existing order was replayed rather than a new one created. */
  readonly replayed: boolean;
}

function hashRequest(input: CreateOrderInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ sku: input.sku, customerRef: input.customerRef ?? null, orderId: input.orderId ?? null }))
    .digest('hex');
}

export class CreateOrderUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      products: ProductRepository;
      orders: OrderRepository;
      paymentEvents: PaymentEventRepository;
      idempotency: IdempotencyRepository;
      applyPaymentEvent: ApplyPaymentEventUseCase;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async execute(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { uow, products, orders, paymentEvents, idempotency, applyPaymentEvent, clock, logger } = this.deps;

    if (input.idempotencyKey) {
      const replay = await this.replay(input);
      if (replay) return replay;
    }

    const product = await products.findBySku(uow.executor, input.sku);
    if (!product) throw new ProductNotFoundError(input.sku);
    if (!product.isActive) throw new ProductInactiveError(input.sku);

    const now = clock.now();
    const order: Order = {
      id: input.orderId ?? newOrderId(),
      productId: product.id,
      sku: product.sku,
      amountMinor: product.priceMinor,
      currency: product.currency,
      customerRef: input.customerRef ?? null,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      paidAt: null,
      deliveredAt: null,
    };

    const created = await uow.withTransaction(async (tx) => {
      if (input.idempotencyKey) {
        const claimed = await idempotency.save(tx, {
          key: input.idempotencyKey,
          requestHash: hashRequest(input),
          status: 201,
          body: { order_id: order.id },
        });
        // Another request holding the same key committed first. Abandon this
        // transaction so no second order exists, then serve the original.
        if (!claimed) return null;
      }
      await orders.insert(tx, order);
      return order;
    });

    if (!created) {
      const replay = await this.replay(input);
      if (replay) return replay;
      throw new IdempotencyConflictError(input.idempotencyKey ?? 'unknown');
    }

    logger.info({ order_id: order.id, sku: order.sku, amount_minor: order.amountMinor }, 'order created');

    // A payment event may already be parked for this id. Applying it here closes
    // the out of order case immediately instead of waiting for the background
    // sweep, which matters because the customer has already paid.
    const deferred = await paymentEvents.findDeferred(uow.executor, order.id);
    for (const event of deferred) {
      logger.info({ order_id: order.id, event_id: event.eventId }, 'applying payment event parked before the order');
      await applyPaymentEvent.retryDeferred(event.eventId);
    }

    const settled = await orders.findById(uow.executor, order.id);
    return { order: settled ?? order, replayed: false };
  }

  /** Serves the order recorded against an Idempotency-Key that was used before. */
  private async replay(input: CreateOrderInput): Promise<CreateOrderResult | null> {
    const { uow, orders, idempotency } = this.deps;
    if (!input.idempotencyKey) return null;

    const stored = await idempotency.find(uow.executor, input.idempotencyKey);
    if (!stored) return null;
    // Same key, different request. Honouring either one would be wrong, so it is refused.
    if (stored.requestHash !== hashRequest(input)) throw new IdempotencyConflictError(input.idempotencyKey);

    const orderId = (stored.body as { order_id?: string }).order_id;
    const order = orderId ? await orders.findById(uow.executor, orderId) : null;
    return order ? { order, replayed: true } : null;
  }
}
