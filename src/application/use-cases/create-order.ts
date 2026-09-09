import { createHash } from 'node:crypto';
import { newOrderId, newOrderItemId, type Order, type OrderItem } from '../../domain/order/order.js';
import {
  IdempotencyConflictError,
  MixedCurrencyBasketError,
  ProductInactiveError,
  ProductNotFoundError,
} from '../../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type {
  IdempotencyRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentEventRepository,
  ProductRepository,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';
import type { ApplyPaymentEventUseCase } from './apply-payment-event.js';

export interface CreateOrderLine {
  readonly sku: string;
  /** Each unit becomes its own line: one unit is one code from one supplier. */
  readonly qty: number;
}

export interface CreateOrderInput {
  readonly items: readonly CreateOrderLine[];
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
  readonly items: readonly OrderItem[];
  /** True when an existing order was replayed rather than a new one created. */
  readonly replayed: boolean;
}

/**
 * Hashes what the request actually asked for, not how it was written.
 *
 * The basket is normalised first, so `[{A,2}]` and `[{A,1},{A,1}]` are the same
 * request under one Idempotency-Key rather than a conflict. Anything else would
 * make a client's harmless reformatting look like an attempt to reuse a key for
 * different goods.
 */
function hashRequest(input: CreateOrderInput): string {
  const normalised = [...input.items]
    .map((line) => ({ sku: line.sku, qty: line.qty }))
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .reduce<Array<{ sku: string; qty: number }>>((acc, line) => {
      const last = acc.at(-1);
      if (last && last.sku === line.sku) last.qty += line.qty;
      else acc.push({ ...line });
      return acc;
    }, []);

  return createHash('sha256')
    .update(
      JSON.stringify({
        items: normalised,
        customerRef: input.customerRef ?? null,
        orderId: input.orderId ?? null,
      }),
    )
    .digest('hex');
}

export class CreateOrderUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      products: ProductRepository;
      orders: OrderRepository;
      orderItems: OrderItemRepository;
      paymentEvents: PaymentEventRepository;
      idempotency: IdempotencyRepository;
      applyPaymentEvent: ApplyPaymentEventUseCase;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async execute(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { uow, orders, orderItems, paymentEvents, idempotency, applyPaymentEvent, clock, logger } = this.deps;

    if (input.idempotencyKey) {
      const replay = await this.replay(input);
      if (replay) return replay;
    }

    const orderId = input.orderId ?? newOrderId();
    const now = clock.now();
    const items = await this.buildItems(orderId, now, input.items);

    // The order total is the sum of the lines and is never supplied by the
    // client. The payment webhook checks its payload against this number, so
    // letting a caller name it would let a caller name what "paid in full" means.
    const amountMinor = items.reduce((total, item) => total + item.priceMinor, 0);

    const order: Order = {
      id: orderId,
      amountMinor,
      currency: items[0]?.currency ?? 'RUB',
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
      await orders.insert(tx, order, items);
      return order;
    });

    if (!created) {
      const replay = await this.replay(input);
      if (replay) return replay;
      throw new IdempotencyConflictError(input.idempotencyKey ?? 'unknown');
    }

    logger.info(
      { order_id: order.id, lines: items.length, amount_minor: order.amountMinor },
      'order created',
    );

    // A payment event may already be parked for this id. Applying it here closes
    // the out of order case immediately instead of waiting for the background
    // sweep, which matters because the customer has already paid.
    const deferred = await paymentEvents.findDeferred(uow.executor, order.id);
    for (const event of deferred) {
      logger.info({ order_id: order.id, event_id: event.eventId }, 'applying payment event parked before the order');
      await applyPaymentEvent.retryDeferred(event.eventId);
    }

    const settled = await orders.findById(uow.executor, order.id);
    return {
      order: settled ?? order,
      items: await orderItems.findByOrder(uow.executor, order.id),
      replayed: false,
    };
  }

  /**
   * Turns the requested basket into lines.
   *
   * One unit is one line, because one unit is one code fetched from one supplier
   * with one request id. Collapsing two units of the same SKU into a quantity
   * would make "one of them failed" inexpressible, which is precisely the case
   * this stage exists to handle.
   */
  private async buildItems(
    orderId: string,
    now: Date,
    lines: readonly CreateOrderLine[],
  ): Promise<readonly OrderItem[]> {
    const { uow, products } = this.deps;
    const items: OrderItem[] = [];

    for (const line of lines) {
      const product = await products.findBySku(uow.executor, line.sku);
      if (!product) throw new ProductNotFoundError(line.sku);
      if (!product.isActive) throw new ProductInactiveError(line.sku);

      // One currency per basket. A mixed basket has no single amount to compare
      // a payment against, and the webhook contract carries exactly one amount
      // and one currency, so this is refused at the door rather than papered
      // over with a conversion nobody asked for.
      const first = items[0];
      if (first && first.currency !== product.currency) {
        throw new MixedCurrencyBasketError(first.currency, product.currency);
      }

      for (let unit = 0; unit < line.qty; unit += 1) {
        items.push({
          id: newOrderItemId(),
          orderId,
          lineNo: items.length + 1,
          productId: product.id,
          sku: product.sku,
          priceMinor: product.priceMinor,
          costMinor: product.costMinor,
          currency: product.currency,
          status: 'pending',
          rounds: 0,
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
          refundedAt: null,
        });
      }
    }

    return items;
  }

  /** Serves the order recorded against an Idempotency-Key that was used before. */
  private async replay(input: CreateOrderInput): Promise<CreateOrderResult | null> {
    const { uow, orders, orderItems, idempotency } = this.deps;
    if (!input.idempotencyKey) return null;

    const stored = await idempotency.find(uow.executor, input.idempotencyKey);
    if (!stored) return null;
    // Same key, different request. Honouring either one would be wrong, so it is refused.
    if (stored.requestHash !== hashRequest(input)) throw new IdempotencyConflictError(input.idempotencyKey);

    const orderId = (stored.body as { order_id?: string }).order_id;
    const order = orderId ? await orders.findById(uow.executor, orderId) : null;
    if (!order) return null;
    return { order, items: await orderItems.findByOrder(uow.executor, order.id), replayed: true };
  }
}
