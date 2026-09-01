/**
 * Drives orders that stopped moving back into delivery.
 *
 * Three failure shapes end up here and all of them are safe to retry, because
 * the retry goes through the same delivery path with the same derived request
 * ids and the same unique constraint underneath.
 *
 *   paid or delivering past the deadline: a worker died, or a job was lost.
 *   out_of_stock: the goods were missing, and stock may be back.
 *   delivery_failed: the suppliers were unwell, and may have recovered.
 *
 * The sweep only enqueues. It never calls a supplier itself, so a slow supplier
 * cannot stall the scan, and the live-job dedupe index means a second sweep
 * cannot pile duplicate work onto an order that is already being retried.
 */
import { deliveryJobDedupeKey } from './apply-payment-event.js';
import type { JobQueue } from '../ports/queue.js';
import type { OrderRepository, PaymentEventRepository } from '../ports/repositories.js';
import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export interface RecoveryReport {
  readonly ordersRequeued: number;
  readonly deferredEventsRequeued: number;
  readonly abandonedJobsRequeued: number;
}

export class RecoverStuckOrdersUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      paymentEvents: PaymentEventRepository;
      queue: JobQueue;
      clock: Clock;
      logger: Logger;
      stuckAfterMs: number;
      batchSize?: number;
    },
  ) {}

  async execute(): Promise<RecoveryReport> {
    const { uow, orders, paymentEvents, queue, clock, logger } = this.deps;
    const batchSize = this.deps.batchSize ?? 100;
    const deadline = new Date(clock.now().getTime() - this.deps.stuckAfterMs);

    // Jobs whose worker died still hold their dedupe slot, so they are released
    // first. Otherwise the enqueues below would be deduplicated against ghosts.
    const abandonedJobsRequeued = await queue.requeueAbandoned(uow.executor, deadline);

    const stuck = await orders.findStuck(uow.executor, deadline, batchSize);
    let ordersRequeued = 0;
    for (const order of stuck) {
      const enqueued = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'deliver_order',
          dedupeKey: deliveryJobDedupeKey(order.id),
          payload: { orderId: order.id },
        }),
      );
      if (enqueued) {
        ordersRequeued += 1;
        logger.warn({ order_id: order.id, status: order.status }, 'stuck order requeued for delivery');
      }
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

    if (ordersRequeued > 0 || deferredEventsRequeued > 0 || abandonedJobsRequeued > 0) {
      logger.info({ ordersRequeued, deferredEventsRequeued, abandonedJobsRequeued }, 'recovery sweep completed');
    }
    return { ordersRequeued, deferredEventsRequeued, abandonedJobsRequeued };
  }
}
