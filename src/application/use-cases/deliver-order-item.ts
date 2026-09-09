/**
 * Delivers ONE line of a paid order.
 *
 * The whole timeout trap lives here, so the rules it follows are stated up front.
 * They are the rules of the first stage, re-pointed at a line: the guarantees
 * were never about the order, they were about "one thing being fetched once".
 *
 * 1. request_id is DERIVED from (line, supplier, epoch), never generated per
 *    attempt. The supplier contract promises the same request_id yields the same
 *    code, which turns every retry after a timeout into a question about the
 *    original call rather than a new order for goods.
 *
 * 2. The intent to call is written BEFORE the call. A process that dies mid
 *    flight leaves a row saying a side effect may exist. Without it, a crashed
 *    delivery is indistinguishable from one that never happened.
 *
 * 3. A timeout is not a refusal. Failing over to the second supplier is allowed
 *    only after the first has definitively said no, or after its retries are
 *    exhausted, and in the latter case the unresolved call is handed to the
 *    reconciler rather than forgotten.
 *
 * 4. The database has the last word. deliveries.order_item_id is UNIQUE, so a
 *    code that arrives for an already delivered line becomes a recorded orphan
 *    instead of a second delivery.
 *
 * What is new at this stage is what happens AFTER: a line that ends without a
 * code no longer strands the whole basket. It ends in a recoverable state, one
 * delivery round is spent, and settlement decides whether to try again or give
 * the money back.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { supplierRequestId } from '../../domain/order/order.js';
import { itemAwaitsDelivery } from '../../domain/order/status.js';
import { rejectSupplierResponse, type ResponseRejection } from '../../domain/order/supplier-response.js';
import { deliveryCostEntries, orphanIssuanceEntries } from '../../domain/ledger/entries.js';
import { backoffDelayMs } from '../retry-policy.js';
import { settlementJobDedupeKey } from './apply-payment-event.js';
import type { SupplierGateway, SupplierResult } from '../ports/supplier-gateway.js';
import { JOB_PRIORITY, type JobQueue } from '../ports/queue.js';
import type { SupplierRateLimiter } from '../ports/rate-limiter.js';
import type {
  DeliveryRepository,
  IssuedCodeRepository,
  LedgerRepository,
  OrderItemRepository,
  OrderRepository,
  ProductRepository,
  SupplierRequestRepository,
} from '../ports/repositories.js';
import type { OrderEventRepository } from '../ports/history.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';
import type { DeliveryMetrics } from '../ports/metrics.js';

export type DeliverOrderItemResult =
  | { readonly kind: 'delivered'; readonly supplier: string; readonly alreadyDelivered: boolean }
  | { readonly kind: 'out_of_stock' }
  | { readonly kind: 'failed'; readonly reason: string }
  /**
   * Every supplier is at its rate limit. Nothing was attempted and nothing is
   * wrong: the line goes back on the queue and waits for capacity.
   */
  | { readonly kind: 'rate_limited'; readonly retryAfter: Date }
  /** Nothing to do: the line is not in a state that owes the customer a code. */
  | { readonly kind: 'not_applicable'; readonly status: string };

interface SupplierOutcome {
  readonly supplier: string;
  readonly requestId: string;
  readonly code: string | null;
  readonly refusedReason: string | null;
  readonly indeterminate: boolean;
  /** True when every answer this supplier gave was refused as invalid. */
  readonly rejected: boolean;
  /**
   * When set, this supplier was NOT asked: it had no capacity to spare.
   *
   * Kept distinct from every failure, because it is not one. A supplier that was
   * never asked has not refused, has not timed out, and has told us nothing
   * about whether it could have served the line.
   */
  readonly rateLimitedUntil: Date | null;
}

export interface DeliverOrderItemOptions {
  readonly maxAttemptsPerSupplier: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /**
   * Fresh request epochs to open at one supplier when its answers keep being
   * rejected as invalid.
   *
   * Bounded, and low. Each one is a new request to a supplier that has already
   * proved it will hand back somebody else's code, so trying many times is
   * mostly a way to consume its stock. Two says "the first bad answer might have
   * been a glitch", and after that the fallback is a better bet.
   */
  readonly maxEpochsPerSupplier: number;
}

export class DeliverOrderItemUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      orderItems: OrderItemRepository;
      products: ProductRepository;
      deliveries: DeliveryRepository;
      supplierRequests: SupplierRequestRepository;
      issuedCodes: IssuedCodeRepository;
      orderEvents: OrderEventRepository;
      ledger: LedgerRepository;
      queue: JobQueue;
      rateLimiter: SupplierRateLimiter;
      /** Ordered: the first is primary, the rest are fallbacks. */
      suppliers: readonly SupplierGateway[];
      options: DeliverOrderItemOptions;
      metrics: DeliveryMetrics;
      logger: Logger;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async execute(orderItemId: string): Promise<DeliverOrderItemResult> {
    const { uow, orderItems, orders, deliveries } = this.deps;

    const item = await orderItems.findById(uow.executor, orderItemId);
    if (!item) return { kind: 'not_applicable', status: 'missing' };

    // Fast path. Re-running delivery for an already delivered line is a normal
    // consequence of at-least-once job execution, not an error.
    const existing = await deliveries.findByItem(uow.executor, orderItemId);
    if (existing) {
      await uow.withTransaction((tx) => orderItems.transition(tx, orderItemId, 'delivering', 'delivered'));
      await this.scheduleSettlement(item.orderId);
      return { kind: 'delivered', supplier: existing.supplier, alreadyDelivered: true };
    }

    if (!itemAwaitsDelivery(item.status)) return { kind: 'not_applicable', status: item.status };

    // The money has to have arrived. A line of an unpaid order owes nobody
    // anything, and fetching a code for it would spend real stock on a sale
    // that has not happened.
    const order = await orders.findById(uow.executor, item.orderId);
    if (!order || !order.paidAt) return { kind: 'not_applicable', status: order?.status ?? 'missing' };

    // Claim the work. Losing this race means another worker holds the line, so
    // this one stops rather than calling suppliers in parallel with it.
    const claimed = await uow.withTransaction((tx) =>
      orderItems.transition(tx, orderItemId, ['pending', 'out_of_stock', 'delivery_failed'], 'delivering'),
    );
    if (!claimed) {
      const current = await orderItems.findById(uow.executor, orderItemId);
      return { kind: 'not_applicable', status: current?.status ?? 'unknown' };
    }

    const outcomes: SupplierOutcome[] = [];
    let soonestRetry: Date | undefined;

    for (const supplier of this.deps.suppliers) {
      // Capacity is taken BEFORE the call and never given back, which is the
      // conservative direction: a token spent on a call that then failed is a
      // request the supplier really did receive, and pretending otherwise is how
      // a retry storm exceeds the limit it is trying to respect.
      const capacity = await this.deps.rateLimiter.tryConsume(uow.executor, supplier.name);
      if (!capacity.allowed) {
        // The soonest of the suppliers, so the line comes back as soon as ANY
        // of them can serve it rather than waiting out the slowest.
        soonestRetry =
          soonestRetry !== undefined && soonestRetry.getTime() < capacity.retryAfter.getTime()
            ? soonestRetry
            : capacity.retryAfter;
        this.deps.logger.debug(
          { order_item_id: orderItemId, supplier: supplier.name, retry_after: capacity.retryAfter },
          'supplier is at its rate limit, skipping it for now',
        );
        continue;
      }

      const outcome = await this.trySupplier(item.orderId, orderItemId, item.sku, supplier);
      outcomes.push(outcome);

      if (outcome.code) {
        return this.finalise(orderItemId, outcome, outcomes);
      }

      if (outcome.indeterminate) {
        // The supplier may have issued a code we never saw. Hand it to the
        // reconciler before moving on, so the possible orphan is chased rather
        // than lost, then fall through to the next supplier so the paying
        // customer is not left waiting on an unanswered call.
        await this.scheduleReconciliation(item.orderId, orderItemId, outcome.requestId);
        this.deps.logger.warn(
          { order_item_id: orderItemId, supplier: outcome.supplier, request_id: outcome.requestId },
          'supplier outcome still unknown after retries, failing over and scheduling reconciliation',
        );
      }
    }

    // At least one supplier was never asked, and no code came from the ones that
    // were. The line goes back exactly as it was — no round spent, no failure
    // recorded, no attempt charged — and waits.
    //
    // The condition is "ANY supplier was throttled", not "all of them were, and
    // that is the difference between a correct system and one that refunds
    // paying customers because a supplier was busy. Charging a round here would
    // spend the line's budget on a question that was never put to the supplier
    // that might have answered yes, and three of those end in a refund.
    //
    // Releasing the claim first matters: leaving the line in `delivering` would
    // make it look owned by a worker that is not working on it.
    if (soonestRetry !== undefined) {
      await uow.withTransaction((tx) => orderItems.transition(tx, orderItemId, 'delivering', item.status));
      return { kind: 'rate_limited', retryAfter: soonestRetry };
    }

    return this.recordNoDelivery(item.orderId, orderItemId, outcomes);
  }

  /**
   * Works one supplier until it produces a usable code or runs out of ways to.
   *
   * Two nested loops with very different meanings, and confusing them is how a
   * timeout turns into two issued codes:
   *
   *   the INNER loop (askOnce) repeats the same request id, because the answer
   *   went missing and the question has not been answered yet;
   *
   *   the OUTER loop here opens a NEW request id, because the answer arrived and
   *   was a lie. Re-asking the same id would return the same lie forever.
   *
   * The outer loop runs only on rejection, and it is bounded low: each epoch is
   * a fresh request to a supplier that has already proved it hands back other
   * people's codes, so persisting mostly consumes its stock.
   */
  private async trySupplier(
    orderId: string,
    orderItemId: string,
    sku: string,
    supplier: SupplierGateway,
  ): Promise<SupplierOutcome> {
    const { uow, supplierRequests, options, logger } = this.deps;

    // Read rather than assumed. Resuming at the highest epoch already reached
    // means a worker restarted after a crash re-asks about the call that may
    // have produced a code, instead of opening a fresh request and buying a
    // second one.
    let epoch = Math.max(1, await supplierRequests.latestEpoch(uow.executor, orderItemId, supplier.name));
    let last: SupplierOutcome | null = null;

    for (let round = 1; round <= options.maxEpochsPerSupplier; round += 1) {
      const outcome = await this.askOnce(orderId, orderItemId, sku, supplier, epoch);
      last = outcome;
      // No capacity is not a bad answer, so it does not earn a new epoch.
      if (outcome.rateLimitedUntil) return outcome;
      if (!outcome.rejected) return outcome;

      logger.warn(
        { order_item_id: orderItemId, supplier: supplier.name, request_id: outcome.requestId, epoch },
        'supplier answer refused as invalid, opening a new request epoch',
      );
      epoch += 1;
    }

    return last as SupplierOutcome;
  }

  /**
   * One request id, asked until it is answered or the retries run out.
   *
   * Reusing the request id across retries is what makes them safe: to the
   * supplier it is the same request, so at most one code is ever issued for it
   * however many times the call is repeated.
   */
  private async askOnce(
    orderId: string,
    orderItemId: string,
    sku: string,
    supplier: SupplierGateway,
    epoch: number,
  ): Promise<SupplierOutcome> {
    const { uow, supplierRequests, options, metrics, logger } = this.deps;
    const pause = this.deps.sleep ?? ((ms: number) => sleep(ms));

    const requestId = supplierRequestId(orderItemId, supplier.name, epoch);

    // A code already issued for this request id is reused rather than re-fetched:
    // asking again would be harmless under the contract, but there is nothing to
    // gain and a supplier round trip to lose.
    //
    // A past REFUSAL deliberately does not short circuit. It was definitive for
    // the attempt that got it, not forever, and treating it as permanent would
    // strand every out_of_stock line the moment stock came back.
    const known = await supplierRequests.find(uow.executor, requestId);
    if (known?.state === 'succeeded' && known.code) {
      logger.info(
        { order_item_id: orderItemId, supplier: supplier.name, request_id: requestId },
        'reusing code from an earlier settled call',
      );
      return {
        supplier: supplier.name,
        requestId,
        code: known.code,
        refusedReason: null,
        indeterminate: false,
        rejected: false,
        rateLimitedUntil: null,
      };
    }

    let lastIndeterminate = false;
    let lastRejection: ResponseRejection | 'already_issued' | null = null;
    let refusedReason: string | null = null;

    for (let attempt = 1; attempt <= options.maxAttemptsPerSupplier; attempt += 1) {
      // Rule 2: the intent is durable before the side effect is possible.
      const record = await supplierRequests.beginAttempt(uow.executor, {
        requestId,
        orderId,
        orderItemId,
        supplier: supplier.name,
        epoch,
      });

      const result: SupplierResult = await supplier.issue({ requestId, orderId, orderItemId, sku });
      await supplierRequests.recordAttempt(uow.executor, {
        orderId,
        orderItemId,
        supplier: supplier.name,
        requestId,
        attemptNo: record.attempts,
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
      metrics.recordSupplierCall(supplier.name, result.kind, result.latencyMs);

      if (result.kind === 'issued') {
        // The supplier said yes. That is not the same as it being true.
        const rejection = await this.validate(
          { orderId, orderItemId, supplier: supplier.name, requestId, sku },
          result,
        );
        if (rejection) {
          lastRejection = rejection;
          await supplierRequests.recordAttempt(uow.executor, {
            orderId,
            orderItemId,
            supplier: supplier.name,
            requestId,
            attemptNo: record.attempts,
            outcome: 'rejected',
            latencyMs: result.latencyMs,
            error: rejection,
          });
          // Definitively closed, but NOT as a refusal: the supplier answered and
          // the answer was unusable. Retrying this id would fetch it again, so
          // the caller opens a new epoch instead.
          await supplierRequests.settle(uow.executor, requestId, 'failed_definitive', {
            failureReason: `rejected:${rejection}`,
          });
          metrics.recordRejection(supplier.name, rejection);
          return {
            supplier: supplier.name,
            requestId,
            code: null,
            refusedReason: `rejected:${rejection}`,
            indeterminate: false,
            rejected: true,
            rateLimitedUntil: null,
          };
        }

        await supplierRequests.settle(uow.executor, requestId, 'succeeded', { code: result.code });
        return {
          supplier: supplier.name,
          requestId,
          code: result.code,
          refusedReason: null,
          indeterminate: false,
          rejected: false,
          rateLimitedUntil: null,
        };
      }

      if (result.kind === 'refused') {
        // The supplier answered. Nothing was issued, so there is nothing to
        // reconcile and the fallback can be tried immediately.
        await supplierRequests.settle(uow.executor, requestId, 'failed_definitive', { failureReason: result.reason });
        return {
          supplier: supplier.name,
          requestId,
          code: null,
          refusedReason: result.reason,
          indeterminate: false,
          rejected: false,
          rateLimitedUntil: null,
        };
      }

      // Indeterminate. Record it as such and ask the same question again.
      lastIndeterminate = true;
      refusedReason = result.reason;
      await supplierRequests.settle(uow.executor, requestId, 'unknown', { failureReason: result.detail });
      metrics.recordRetry(supplier.name);

      if (attempt < options.maxAttemptsPerSupplier) {
        await pause(backoffDelayMs(attempt, { baseMs: options.backoffBaseMs, maxMs: options.backoffMaxMs }));
      }
    }

    return {
      supplier: supplier.name,
      requestId,
      code: null,
      refusedReason,
      indeterminate: lastIndeterminate,
      rejected: lastRejection !== null && !lastIndeterminate,
      rateLimitedUntil: null,
    };
  }

  /**
   * Decides whether a "success" from the supplier can be believed.
   *
   * Two checks, and they answer different kinds of question.
   *
   * The first is about the RESPONSE and is pure: does it name the request we
   * made, and is the code for the product we asked for. A supplier that answers
   * about a different request id, or hands over a key from another SKU's pool,
   * has said something self evidently wrong and no lookup is needed to know it.
   *
   * The second is about the WORLD and can only be settled by the database:
   * has this code already been promised to somebody. That is the one that
   * catches a silent duplicate, and it has to be a claim rather than a check,
   * because a check would go stale between asking and acting — two lines racing
   * on the same duplicated code would both look up, both see nothing, and both
   * deliver it. The primary key on issued_codes.code makes exactly one of them
   * win.
   *
   * A rejected code is recorded in quarantine and NOT written off as shrinkage.
   * Shrinkage means stock that was consumed with no sale behind it; a code we
   * were never entitled to was not our stock, and charging ourselves for it
   * would inflate the loss with something that never happened. The discrepancy
   * is visible in the reconciliation report instead, which is where a human
   * looking for a misbehaving supplier would go.
   */
  private async validate(
    context: { orderId: string; orderItemId: string; supplier: string; requestId: string; sku: string },
    result: Extract<SupplierResult, { kind: 'issued' }>,
  ): Promise<ResponseRejection | 'already_issued' | null> {
    const { uow, issuedCodes, logger } = this.deps;

    const malformed = rejectSupplierResponse(
      { requestId: result.requestId, sku: result.sku, code: result.code },
      { requestId: context.requestId, sku: context.sku },
    );

    const rejection =
      malformed ??
      // The claim. Not a lookup: this has to be the write that decides.
      ((await uow.withTransaction((tx) =>
        issuedCodes.claim(tx, {
          code: result.code,
          supplier: context.supplier,
          requestId: context.requestId,
          orderItemId: context.orderItemId,
          orderId: context.orderId,
          // Provisional. The code is now spoken for by this line, and finalise
          // promotes it to `delivered` once the delivery row is actually
          // written. If delivery then loses to a concurrent winner, the code
          // becomes an orphan — but it can never become somebody else's.
          disposition: 'delivered',
          reason: null,
        }),
      ))
        ? null
        : 'already_issued');

    if (!rejection) return null;

    // Quarantine the code so it can never be handed to anybody, including by a
    // later attempt on this same line. `already_issued` is the exception: the
    // code is legitimately registered to somebody else and must keep pointing at
    // them, so there is nothing to record beyond the attempt itself.
    if (rejection !== 'already_issued') {
      await uow.withTransaction((tx) =>
        issuedCodes.claim(tx, {
          code: result.code,
          supplier: context.supplier,
          requestId: context.requestId,
          orderItemId: null,
          orderId: null,
          disposition: 'quarantined',
          reason: rejection,
        }),
      );
      await uow.withTransaction((tx) =>
        this.deps.orderEvents.append(tx, [
          {
            orderId: context.orderId,
            orderItemId: context.orderItemId,
            type: 'code_quarantined',
            payload: { supplier: context.supplier, requestId: context.requestId, reason: rejection },
          },
        ]),
      );
    }

    logger.error(
      {
        order_item_id: context.orderItemId,
        supplier: context.supplier,
        request_id: context.requestId,
        echoed_request_id: result.requestId,
        echoed_sku: result.sku,
        expected_sku: context.sku,
        rejection,
      },
      'supplier returned a code we cannot accept',
    );
    return rejection;
  }

  /**
   * Writes the delivery, or records an orphan if the line was already served.
   *
   * Everything here is one transaction: the delivery row, the line status, the
   * stock counter and the money journal move together or not at all.
   */
  private async finalise(
    orderItemId: string,
    winner: SupplierOutcome,
    outcomes: readonly SupplierOutcome[],
  ): Promise<DeliverOrderItemResult> {
    const { uow, orderItems, products, deliveries, issuedCodes, orderEvents, ledger, metrics, logger } = this.deps;
    const code = winner.code;
    if (!code) throw new Error('finalise called without a code');

    const result = await uow.withTransaction(async (tx) => {
      const item = await orderItems.lockById(tx, orderItemId);
      if (!item) throw new Error(`order item ${orderItemId} vanished during delivery`);

      // Layer 3. The database decides whether this is the delivery or a surplus code.
      const recorded = await deliveries.recordIfAbsent(tx, {
        orderId: item.orderId,
        orderItemId,
        supplier: winner.supplier,
        requestId: winner.requestId,
        code,
      });

      if (!recorded) {
        // Someone else already delivered this line. Our code is real stock that
        // was consumed with no sale behind it, so it is written off rather than
        // handed over or silently dropped.
        await deliveries.recordOrphan(tx, {
          orderId: item.orderId,
          orderItemId,
          supplier: winner.supplier,
          requestId: winner.requestId,
          code,
          note: 'line was already delivered when this code arrived',
        });
        // The registry already holds this code for us, provisionally as a
        // delivery. It is not one, so it is corrected to what it actually is:
        // stock consumed with no sale behind it. It stays OURS either way —
        // releasing it would put a code a supplier already spent back into
        // circulation.
        await issuedCodes.reclassify(tx, code, 'orphan', 'line was already delivered');
        await ledger.append(
          tx,
          orphanIssuanceEntries({
            orderId: item.orderId,
            orderItemId,
            costMinor: item.costMinor,
            currency: item.currency,
            requestId: winner.requestId,
          }),
        );
        metrics.recordOrphan(winner.supplier);
        logger.error(
          { order_item_id: orderItemId, supplier: winner.supplier, request_id: winner.requestId },
          'code arrived for an already delivered line, written off as shrinkage',
        );
        return {
          orderId: item.orderId,
          outcome: { kind: 'delivered', supplier: winner.supplier, alreadyDelivered: true } as const,
        };
      }

      await orderItems.transition(tx, orderItemId, 'delivering', 'delivered');
      await products.adjustStock(tx, item.productId, -1);
      // Appended in the same transaction as the delivery it describes, so the
      // history cannot drift from the rows it explains.
      await orderEvents.append(tx, [
        {
          orderId: item.orderId,
          orderItemId,
          type: 'item_delivered',
          payload: {
            sku: item.sku,
            priceMinor: item.priceMinor,
            supplier: winner.supplier,
            requestId: winner.requestId,
          },
        },
      ]);
      await ledger.append(
        tx,
        deliveryCostEntries({
          orderId: item.orderId,
          orderItemId,
          costMinor: item.costMinor,
          currency: item.currency,
          requestId: winner.requestId,
        }),
      );

      metrics.recordDelivery(winner.supplier);
      logger.info(
        {
          order_id: item.orderId,
          order_item_id: orderItemId,
          supplier: winner.supplier,
          request_id: winner.requestId,
          suppliers_tried: outcomes.map((outcome) => outcome.supplier),
        },
        'order item delivered',
      );
      return {
        orderId: item.orderId,
        outcome: { kind: 'delivered', supplier: winner.supplier, alreadyDelivered: false } as const,
      };
    });

    // Outside the transaction on purpose: settlement reads every line of the
    // order, and enqueueing it while still holding this line's lock would have
    // it queue behind the very transaction that is trying to schedule it.
    await this.scheduleSettlement(result.orderId);
    return result.outcome;
  }

  /**
   * No supplier produced a code for this line.
   *
   * The distinction matters: out_of_stock says the goods are missing and the
   * line resumes as soon as stock returns, delivery_failed says the suppliers
   * are unwell and it resumes when they recover. Both are recoverable, and
   * neither loses the customer's money — settlement decides, after a bounded
   * number of rounds, whether to keep trying or give it back.
   */
  private async recordNoDelivery(
    orderId: string,
    orderItemId: string,
    outcomes: readonly SupplierOutcome[],
  ): Promise<DeliverOrderItemResult> {
    const { uow, orderItems, logger } = this.deps;
    const everyRefusalIsStock =
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome.refusedReason === 'out_of_stock') &&
      !outcomes.some((outcome) => outcome.indeterminate || outcome.rejected);

    const nextStatus = everyRefusalIsStock ? 'out_of_stock' : 'delivery_failed';
    const rounds = await uow.withTransaction(async (tx) => {
      await orderItems.transition(tx, orderItemId, 'delivering', nextStatus);
      // One full pass through every supplier is one round. The retries inside a
      // single supplier are the timeout trap being handled and must not count,
      // or a slow supplier would look like an unfulfillable line.
      return orderItems.countRound(tx, orderItemId);
    });

    logger.warn(
      {
        order_id: orderId,
        order_item_id: orderItemId,
        status: nextStatus,
        rounds,
        outcomes: outcomes.map((outcome) => ({
          supplier: outcome.supplier,
          reason: outcome.refusedReason,
          indeterminate: outcome.indeterminate,
        })),
      },
      'delivery did not produce a code, line left in a recoverable state',
    );

    await this.scheduleSettlement(orderId);

    return everyRefusalIsStock
      ? { kind: 'out_of_stock' }
      : {
          kind: 'failed',
          reason: outcomes.map((outcome) => `${outcome.supplier}:${outcome.refusedReason ?? 'unknown'}`).join(','),
        };
  }

  /**
   * Asks for the order to be settled.
   *
   * Every line reports here when it stops moving, and the dedupe key collapses
   * the reports of a three line basket into one settlement pass. Settlement is
   * the only place that decides the order's fate, so no line ever has to know
   * what the others did.
   */
  private async scheduleSettlement(orderId: string): Promise<void> {
    await this.deps.uow.withTransaction((tx) =>
      this.deps.queue.enqueue(tx, {
        kind: 'settle_order',
        dedupeKey: settlementJobDedupeKey(orderId),
        payload: { orderId },
        priority: JOB_PRIORITY.DEFAULT,
      }),
    );
  }

  private async scheduleReconciliation(orderId: string, orderItemId: string, requestId: string): Promise<void> {
    await this.deps.uow.withTransaction((tx) =>
      this.deps.queue.enqueue(tx, {
        kind: 'reconcile_supplier_request',
        dedupeKey: `reconcile:${requestId}`,
        payload: { orderId, orderItemId, requestId },
        runAfter: new Date(Date.now() + 1_000),
      }),
    );
  }
}
