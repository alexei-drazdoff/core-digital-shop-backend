/**
 * Binds job kinds to use cases.
 *
 * Every handler here has to be safe to run more than once, because the queue
 * guarantees at-least-once and nothing else. That safety is not implemented in
 * the handlers: it comes from the derived request ids and the unique constraints
 * underneath them, which is why the handlers can stay this thin.
 */
import type { Job, JobKind } from '../application/ports/queue.js';
import { JobDeferredError, type JobHandler } from '../infrastructure/queue/worker.js';
import type { Container } from './container.js';

export function buildJobHandlers(container: Container): Readonly<Record<JobKind, JobHandler>> {
  const { useCases, logger } = container;

  return {
    deliver_order_item: async (job: Job) => {
      const orderItemId = job.payload['orderItemId'];
      if (typeof orderItemId !== 'string') throw new Error('deliver_order_item job is missing orderItemId');
      const result = await useCases.deliverOrderItem.execute(orderItemId);

      // No capacity at any supplier. Thrown rather than returned because the
      // worker owns the queue, and thrown as its OWN type because a deferral is
      // the opposite of a failure: nothing was tried, so nothing is charged and
      // the job cannot die of waiting.
      if (result.kind === 'rate_limited') {
        throw new JobDeferredError(result.retryAfter, 'supplier rate limit reached');
      }

      logger.debug({ order_item_id: orderItemId, result: result.kind }, 'delivery job finished');
    },

    settle_order: async (job: Job) => {
      const orderId = job.payload['orderId'];
      if (typeof orderId !== 'string') throw new Error('settle_order job is missing orderId');
      const result = await useCases.settleOrder.execute(orderId);
      logger.debug(
        { order_id: orderId, status: result.status, refunds: result.refundsWritten },
        'settlement job finished',
      );
    },

    reconcile_supplier_request: async (job: Job) => {
      const requestId = job.payload['requestId'];
      if (typeof requestId !== 'string') throw new Error('reconcile_supplier_request job is missing requestId');
      const result = await useCases.reconcileSupplierRequest.execute(requestId);

      // No capacity to even ask. Waiting, not failing: the claim is untouched.
      if (result.kind === 'rate_limited') {
        throw new JobDeferredError(result.retryAfter, 'supplier rate limit reached');
      }

      // Still no answer from the supplier. Throwing puts the job back on the
      // queue with backoff, which is exactly the retry the claim needs; silently
      // succeeding would abandon a possible orphan.
      if (result.kind === 'still_unknown') {
        throw new Error(`supplier request ${requestId} is still unresolved`);
      }
      logger.info({ request_id: requestId, result: result.kind }, 'supplier reconciliation finished');
    },

    apply_deferred_event: async (job: Job) => {
      const eventId = job.payload['eventId'];
      if (typeof eventId !== 'string') throw new Error('apply_deferred_event job is missing eventId');
      const result = await useCases.applyPaymentEvent.retryDeferred(eventId);
      logger.debug({ event_id: eventId, result: result.kind }, 'deferred payment event replayed');
    },
  };
}
