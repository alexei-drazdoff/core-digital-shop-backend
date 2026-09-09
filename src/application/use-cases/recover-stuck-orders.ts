/**
 * Drives work that stopped moving back into flight.
 *
 * Three failure shapes end up here and all of them are safe to retry, because
 * the retry goes through the same delivery path with the same derived request
 * ids and the same unique constraints underneath.
 *
 *   pending or delivering past the deadline: a worker died, or a job was lost.
 *   out_of_stock: the goods were missing, and stock may be back.
 *   delivery_failed: the suppliers were unwell, and may have recovered.
 *
 * The sweep works at the level of LINES, not orders. A basket where two lines
 * are delivered and one is stuck is not a stuck order by any status you could
 * read off the order row, and sweeping orders would leave that third line
 * unfetched forever while the report cheerfully said the order was in progress.
 *
 * It only enqueues. It never calls a supplier itself, so a slow supplier cannot
 * stall the scan, and the live-job dedupe index means a second sweep cannot pile
 * duplicate work onto a line that is already being retried.
 */
import { deliveryJobDedupeKey, settlementJobDedupeKey } from './apply-payment-event.js';
import { JOB_PRIORITY, type JobQueue } from '../ports/queue.js';
import type { OrderItemRepository, OrderRepository, PaymentEventRepository } from '../ports/repositories.js';
import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export interface RecoveryReport {
  readonly itemsReleased: number;
  readonly itemsRequeued: number;
  readonly ordersResettled: number;
  readonly deferredEventsRequeued: number;
  readonly abandonedJobsRequeued: number;
}

export class RecoverStuckOrdersUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      orderItems: OrderItemRepository;
      paymentEvents: PaymentEventRepository;
      queue: JobQueue;
      clock: Clock;
      logger: Logger;
      stuckAfterMs: number;
      /** Mirrors SettleOrderOptions: a line past its budget is settlement's problem. */
      maxDeliveryRounds: number;
      batchSize?: number;
    },
  ) {}

  async execute(): Promise<RecoveryReport> {
    const { uow, orders, orderItems, paymentEvents, queue, clock, logger } = this.deps;
    const batchSize = this.deps.batchSize ?? 100;
    const deadline = new Date(clock.now().getTime() - this.deps.stuckAfterMs);

    // Jobs whose worker died still hold their dedupe slot, so they are released
    // first. Otherwise the enqueues below would be deduplicated against ghosts.
    const abandonedJobsRequeued = await queue.requeueAbandoned(uow.executor, deadline);

    // The same problem one level down. A line left in `delivering` by a dead
    // worker cannot be claimed by a new one, because the claim refuses to take a
    // line somebody is supposedly already working on. Released before the scan,
    // so the very sweep that notices the abandonment also picks the line up.
    const itemsReleased = await uow.withTransaction((tx) =>
      orderItems.releaseStaleDelivering(tx, deadline, batchSize),
    );
    if (itemsReleased > 0) {
      logger.warn({ itemsReleased }, 'order lines released from delivering after their worker disappeared');
    }

    const stuckItems = await orderItems.findStuck(uow.executor, deadline, batchSize, this.deps.maxDeliveryRounds);
    const touchedOrders = new Set<string>();
    let itemsRequeued = 0;

    for (const item of stuckItems) {
      touchedOrders.add(item.orderId);
      const enqueued = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'deliver_order_item',
          dedupeKey: deliveryJobDedupeKey(item.id),
          payload: { orderItemId: item.id },
          // Paid, so it outranks everything unpaid — but below a first attempt,
          // because a customer who has not been tried yet is worse off than one
          // whose line is being retried.
          priority: JOB_PRIORITY.PAID_RETRY,
        }),
      );
      if (enqueued) {
        itemsRequeued += 1;
        logger.warn(
          { order_id: item.orderId, order_item_id: item.id, status: item.status, rounds: item.rounds },
          'stuck order line requeued for delivery',
        );
      }
    }

    // Orders whose lines are all resolved but whose own status never caught up,
    // because the process died between the last delivery and its settlement.
    // Settlement is cheap and idempotent, so asking again costs a query and
    // closes the only hole that would otherwise leave a fully delivered basket
    // sitting in `delivering`.
    for (const order of await orders.findStuck(uow.executor, deadline, batchSize)) {
      touchedOrders.add(order.id);
    }

    let ordersResettled = 0;
    for (const orderId of touchedOrders) {
      const enqueued = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'settle_order',
          dedupeKey: settlementJobDedupeKey(orderId),
          payload: { orderId },
        }),
      );
      if (enqueued) ordersResettled += 1;
    }

    // Events parked before their order existed. Their order may have shown up since.
    const deferred = await paymentEvents.findAnyDeferred(uow.executor, batchSize);
    let deferredEventsRequeued = 0;
    for (const event of deferred) {
      const order = await orders.findById(uow.executor, event.orderId);
      if (!order) continue;
      const enqueued = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'apply_deferred_event',
          dedupeKey: `deferred:${event.eventId}`,
          payload: { eventId: event.eventId },
        }),
      );
      if (enqueued) deferredEventsRequeued += 1;
    }

    if (itemsRequeued > 0 || ordersResettled > 0 || deferredEventsRequeued > 0 || abandonedJobsRequeued > 0) {
      logger.info(
        { itemsReleased, itemsRequeued, ordersResettled, deferredEventsRequeued, abandonedJobsRequeued },
        'recovery sweep completed',
      );
    }
    return { itemsReleased, itemsRequeued, ordersResettled, deferredEventsRequeued, abandonedJobsRequeued };
  }
}
