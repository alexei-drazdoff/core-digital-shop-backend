/**
 * Chases every supplier call whose outcome is still unknown, without being asked.
 *
 * The assignment requires that discrepancies with a supplier are found and
 * resolved "автоматически, без ручного вмешательства", and this is what makes
 * that true rather than aspirational.
 *
 * The delivery path already schedules a reconciliation the moment it gives up on
 * an unanswered call, so in the normal case this sweep finds nothing. It exists
 * for the cases where that scheduling never happened or did not survive:
 *
 *   the worker died between the supplier call and the enqueue;
 *   the reconciliation job exhausted its retries and went dead;
 *   the process was killed while a request row said `in_flight`, so no code has
 *   ever been reported and nobody is looking for one.
 *
 * Each of those leaves a row asserting "a supplier may have consumed a key for
 * us" with nothing driving it to a conclusion. Left alone they become silent
 * stock loss and books that stop matching, which is precisely what a
 * reconciliation report is supposed to make impossible.
 *
 * The sweep only enqueues. It never calls a supplier itself, so a supplier that
 * hangs cannot stall the scan.
 */
import type { JobQueue } from '../ports/queue.js';
import type { SupplierRequestRepository } from '../ports/repositories.js';
import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export interface DiscrepancyReport {
  readonly unresolved: number;
  readonly scheduled: number;
}

export class SweepSupplierDiscrepanciesUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      supplierRequests: SupplierRequestRepository;
      queue: JobQueue;
      clock: Clock;
      logger: Logger;
      /**
       * How long a call may stay unresolved before it is chased.
       *
       * Shares the stuck-order deadline rather than having a knob of its own:
       * both answer "has this stopped moving", and two thresholds that must be
       * kept in step are one more thing to get wrong.
       */
      staleAfterMs: number;
      batchSize?: number;
    },
  ) {}

  async execute(): Promise<DiscrepancyReport> {
    const { uow, supplierRequests, queue, clock, logger } = this.deps;
    const batchSize = this.deps.batchSize ?? 100;
    const deadline = new Date(clock.now().getTime() - this.deps.staleAfterMs);

    const unresolved = await supplierRequests.findUnsettled(uow.executor, deadline, batchSize);
    let scheduled = 0;

    for (const request of unresolved) {
      // The same dedupe key the delivery path uses, so a claim already being
      // chased is not chased twice.
      const enqueued = await uow.withTransaction((tx) =>
        queue.enqueue(tx, {
          kind: 'reconcile_supplier_request',
          dedupeKey: `reconcile:${request.requestId}`,
          payload: {
            orderId: request.orderId,
            orderItemId: request.orderItemId,
            requestId: request.requestId,
          },
        }),
      );
      if (enqueued) scheduled += 1;
    }

    if (scheduled > 0) {
      logger.warn(
        { unresolved: unresolved.length, scheduled },
        'supplier claims left unresolved were picked up by the discrepancy sweep',
      );
    }
    return { unresolved: unresolved.length, scheduled };
  }
}
