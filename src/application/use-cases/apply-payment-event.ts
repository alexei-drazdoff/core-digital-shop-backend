/**
 * Applies one payment event to its order.
 *
 * This is where the exactly-once story is decided, so the ordering of the steps
 * inside the transaction is deliberate:
 *
 *   1. claim the event by its id, which collapses duplicate deliveries;
 *   2. lock the order row, which serialises distinct events for the same order;
 *   3. ask the state machine what the event should do;
 *   4. transition with the expected status in the WHERE clause;
 *   5. journal the money and enqueue the delivery job in the SAME transaction.
 *
 * Step 5 is the transactional outbox. An order can never be paid without a
 * delivery job, and a delivery job can never exist for a payment that rolled back.
 */
import { decidePaymentEffect } from '../../domain/order/status.js';
import { paymentCapturedEntries } from '../../domain/ledger/entries.js';
import { JOB_PRIORITY, type JobQueue } from '../ports/queue.js';
import type {
  IncomingPaymentEvent,
  LedgerRepository,
  OrderItemRepository,
  OrderRepository,
  PaymentEventOutcome,
  PaymentEventRepository,
} from '../ports/repositories.js';
import type { TransactionScope, UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export type ApplyPaymentResult =
  /** The same event_id was already accepted. Nothing to do, and that is the correct answer. */
  | { readonly kind: 'duplicate' }
  /** The order does not exist yet. The event is parked and replayed later. */
  | { readonly kind: 'deferred' }
  | { readonly kind: 'applied'; readonly nextStatus: string }
  | { readonly kind: 'ignored'; readonly outcome: PaymentEventOutcome };

export function deliveryJobDedupeKey(orderItemId: string): string {
  return `deliver:${orderItemId}`;
}

/** One settlement per order, however many lines finished at once. */
export function settlementJobDedupeKey(orderId: string): string {
  return `settle:${orderId}`;
}

export class ApplyPaymentEventUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      orderItems: OrderItemRepository;
      paymentEvents: PaymentEventRepository;
      ledger: LedgerRepository;
      queue: JobQueue;
      logger: Logger;
    },
  ) {}

  /** Normal path: an event arriving from the payment provider. */
  async execute(event: IncomingPaymentEvent): Promise<ApplyPaymentResult> {
    const { uow, paymentEvents, logger } = this.deps;

    return uow.withTransaction(async (tx) => {
      // Layer 1. The primary key on event_id decides who proceeds. Under 50
      // concurrent deliveries of one event, exactly one claim returns true.
      const claimed = await paymentEvents.claim(tx, event);
      if (!claimed) {
        logger.debug({ event_id: event.eventId, order_id: event.orderId }, 'duplicate payment event ignored');
        return { kind: 'duplicate' } as const;
      }
      return this.applyToOrder(tx, event);
    });
  }

  /**
   * Replay path: an event that was parked because its order did not exist yet.
   *
   * It is already stored, so there is nothing to claim. Instead the stored row
   * is locked while still unprocessed, which gives the same single-winner
   * guarantee: a concurrent replay finds it processed and does nothing.
   */
  async retryDeferred(eventId: string): Promise<ApplyPaymentResult> {
    const { uow, paymentEvents } = this.deps;

    return uow.withTransaction(async (tx) => {
      const event = await paymentEvents.lockIfDeferred(tx, eventId);
      if (!event) return { kind: 'duplicate' } as const;
      return this.applyToOrder(tx, event);
    });
  }

  /** Everything both paths share, once the event is exclusively held. */
  private async applyToOrder(tx: TransactionScope, event: IncomingPaymentEvent): Promise<ApplyPaymentResult> {
    const { orders, orderItems, paymentEvents, ledger, queue, logger } = this.deps;

    // Serialises distinct events racing for the same order. No supplier call
    // ever happens while this lock is held, so it cannot be pinned by a timeout.
    const order = await orders.lockById(tx, event.orderId);
    if (!order) {
      await paymentEvents.markDeferred(tx, event.eventId);
      logger.warn({ event_id: event.eventId, order_id: event.orderId }, 'payment event arrived before its order');
      return { kind: 'deferred' } as const;
    }

    if (event.status === 'paid' && event.amountMinor !== order.amountMinor) {
      // Recorded rather than acted on. Moving an order to paid on the strength
      // of a payload that disagrees with the price would be a money bug.
      await paymentEvents.markProcessed(tx, event.eventId, 'amount_mismatch');
      logger.error(
        { event_id: event.eventId, order_id: order.id, expected: order.amountMinor, received: event.amountMinor },
        'payment amount does not match the order',
      );
      return { kind: 'ignored', outcome: 'amount_mismatch' } as const;
    }

    const decision = decidePaymentEffect(order.status, event.status);
    if (decision.kind === 'ignore') {
      await paymentEvents.markProcessed(tx, event.eventId, decision.outcome);
      logger.debug(
        { event_id: event.eventId, order_id: order.id, status: order.status, outcome: decision.outcome },
        'payment event had no effect',
      );
      return { kind: 'ignored', outcome: decision.outcome } as const;
    }

    // Layer 2. The row lock above already makes this deterministic; keeping the
    // expected status in the WHERE clause means correctness does not depend on
    // that lock still being here in a year.
    const moved = await orders.transition(tx, order.id, order.status, decision.nextStatus);
    if (!moved) {
      await paymentEvents.markProcessed(tx, event.eventId, 'ignored_stale');
      return { kind: 'ignored', outcome: 'ignored_stale' } as const;
    }

    if (decision.nextStatus === 'paid') {
      await ledger.append(
        tx,
        paymentCapturedEntries({
          orderId: order.id,
          amountMinor: order.amountMinor,
          currency: order.currency,
          eventId: event.eventId,
        }),
      );

      // The outbox write, fanned out over the basket.
      //
      // One job per line rather than one per order, because the lines are
      // independent: a supplier that hangs on line 1 must not hold line 2, and a
      // retry of line 1 must not re-drive a line that already succeeded. It is
      // still the same atomic fact as before, just wider — "paid" and "every
      // line scheduled" commit together, so no line can be paid for and
      // forgotten.
      const items = await orderItems.findByOrder(tx, order.id);
      for (const item of items) {
        await queue.enqueue(tx, {
          kind: 'deliver_order_item',
          dedupeKey: deliveryJobDedupeKey(item.id),
          payload: { orderItemId: item.id },
          // The money has just arrived, so this is the highest priority work in
          // the system. When supplier capacity is scarce it goes first.
          priority: JOB_PRIORITY.PAID_DELIVERY,
        });
      }
    }

    await paymentEvents.markProcessed(tx, event.eventId, 'applied');
    logger.info(
      { event_id: event.eventId, order_id: order.id, from: order.status, to: decision.nextStatus },
      'payment event applied',
    );
    return { kind: 'applied', nextStatus: decision.nextStatus } as const;
  }
}
