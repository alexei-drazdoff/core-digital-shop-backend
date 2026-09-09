/**
 * Decides what a partially fulfilled basket owes, and closes it out.
 *
 * This is the use case the second stage exists for. Delivery of a single line
 * knows only about that line; somebody has to look at the whole basket and say
 * "two of these arrived, one never will, give back the money for the third and
 * call the order finished". That is here, in one place, because the money
 * invariant is a statement about the whole order and cannot be maintained by
 * three independent workers each holding one line.
 *
 * Three properties are load bearing:
 *
 * 1. It is idempotent by construction, not by bookkeeping. A refund is written
 *    with INSERT ... ON CONFLICT (order_item_id) DO NOTHING and its ledger group
 *    is keyed on the line, so running settlement fifty times produces one refund
 *    and one pair of entries. Nothing counts how many times it ran.
 *
 * 2. It never invents an outcome. The order's status is derived from the lines
 *    by `deriveOrderStatus`, so an order cannot claim to be delivered while a
 *    line is pending, nor claim to have failed while a line was handed over.
 *
 * 3. It refuses to write money that does not add up. `assertSettles` is checked
 *    before the refunds are journalled, so a basket whose lines disagree with
 *    its total fails loudly instead of silently paying out the difference.
 */
import { deriveOrderStatus } from '../../domain/order/status.js';
import { assertSettles, settle, type SettlementLine } from '../../domain/order/settlement.js';
import { refundEntries } from '../../domain/ledger/entries.js';
import type {
  LedgerRepository,
  OrderItemRepository,
  OrderRepository,
  RefundRepository,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../../infrastructure/db/unit-of-work.js';
import type { Logger } from '../../infrastructure/observability/logger.js';

export interface SettleOrderResult {
  readonly orderId: string;
  /** Null while the order is still working: some lines have neither a code nor a refund. */
  readonly status: string | null;
  readonly deliveredMinor: number;
  readonly refundedMinor: number;
  readonly refundsWritten: number;
}

export interface SettleOrderOptions {
  /**
   * Full passes through every supplier before a line is written off.
   *
   * Bounded on purpose. "За что не смогли, деньги возвращаются" is only true if
   * the trying eventually stops; an unbounded retry would leave an out of stock
   * line pending forever and the customer's money with us.
   */
  readonly maxDeliveryRounds: number;
}

export class SettleOrderUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      orders: OrderRepository;
      orderItems: OrderItemRepository;
      refunds: RefundRepository;
      ledger: LedgerRepository;
      options: SettleOrderOptions;
      logger: Logger;
    },
  ) {}

  async execute(orderId: string): Promise<SettleOrderResult> {
    const { uow, orders, orderItems, refunds, ledger, logger, options } = this.deps;

    const outcome = await uow.withTransaction(async (tx) => {
      const order = await orders.lockById(tx, orderId);
      if (!order) return null;

      // Nothing to settle before the money arrived. Refunding a line of an
      // unpaid order would give back money that was never taken.
      if (!order.paidAt || order.status === 'payment_failed') return null;

      // Locked by line_no, always. Two settlements of the same order therefore
      // take the same locks in the same sequence and cannot deadlock.
      const items = await orderItems.lockByOrder(tx, orderId);
      if (items.length === 0) return null;

      const written: string[] = [];

      for (const item of items) {
        if (item.status === 'delivered' || item.status === 'refunded') continue;

        // Still worth another go: the goods may come back in stock or the
        // supplier may recover, and the customer would rather have the code
        // than the money.
        //
        // Settlement deliberately does NOT re-enqueue it. Retrying from here
        // would be a busy loop: the line just failed, the supplier is by
        // definition unwell or out of stock, and an immediate retry would burn
        // the whole budget in the time it takes to drain the queue once. The
        // recovery sweep owns the retry, and it waits STUCK_ORDER_AFTER_MS
        // before touching anything, which is the pause this needs.
        if (item.rounds < options.maxDeliveryRounds) continue;

        // The budget is spent, so this line is written off. The TRANSITION goes
        // first and the money follows it, because the transition is what
        // arbitrates the race.
        //
        // A line in `delivering` is being fetched by a worker right now. That
        // worker may be about to commit a delivery, so refunding it would leave
        // the customer holding both the code and the money — the one failure
        // that breaks paid = delivered + refunded while every account still
        // balances. The guarded UPDATE excludes `delivering`, so it matches no
        // row, and nothing is paid out. Writing the refund first and hoping the
        // transition agreed would do exactly the wrong thing.
        const writtenOff = await orderItems.transition(
          tx,
          item.id,
          ['pending', 'out_of_stock', 'delivery_failed'],
          'refunded',
        );
        if (!writtenOff) continue;

        const fresh = await refunds.recordIfAbsent(tx, {
          orderId,
          orderItemId: item.id,
          amountMinor: item.priceMinor,
          currency: item.currency,
          reason: item.status === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed',
        });
        if (fresh) written.push(item.id);

        await ledger.append(
          tx,
          refundEntries({
            orderId,
            orderItemId: item.id,
            amountMinor: item.priceMinor,
            currency: item.currency,
          }),
        );
      }

      // Re-read under the same lock: the statuses above changed, and the order's
      // fate has to be derived from what is true now rather than from what was
      // true when the transaction opened.
      const finalItems = await orderItems.lockByOrder(tx, orderId);
      const lines: SettlementLine[] = finalItems.map((item) => ({
        id: item.id,
        status: item.status,
        priceMinor: item.priceMinor,
      }));

      // Refuses to leave the transaction with money that does not add up. The
      // only way this fails is a basket whose lines disagree with its total,
      // which is a defect worth a rollback rather than a payout.
      const settlement = assertSettles(orderId, settle(order.amountMinor, lines));

      // Skipped when the derived status is the one already stored: writing it
      // would only move updated_at, and updated_at is what the stuck sweep reads
      // to decide whether anything is actually progressing.
      const derived = deriveOrderStatus(finalItems);
      const nextStatus = derived && derived !== order.status ? derived : null;
      if (nextStatus) {
        await orders.transition(
          tx,
          orderId,
          ['paid', 'delivering', 'out_of_stock', 'delivery_failed'],
          nextStatus,
        );
      }

      return { order, settlement, nextStatus, refundsWritten: written.length };
    });

    if (!outcome) {
      return {
        orderId,
        status: null,
        deliveredMinor: 0,
        refundedMinor: 0,
        refundsWritten: 0,
      };
    }

    if (outcome.refundsWritten > 0 || outcome.nextStatus) {
      logger.info(
        {
          order_id: orderId,
          status: outcome.nextStatus,
          paid_minor: outcome.settlement.paidMinor,
          delivered_minor: outcome.settlement.deliveredMinor,
          refunded_minor: outcome.settlement.refundableMinor,
          refunds_written: outcome.refundsWritten,
        },
        'order settled',
      );
    }

    return {
      orderId,
      status: outcome.nextStatus,
      deliveredMinor: outcome.settlement.deliveredMinor,
      refundedMinor: outcome.settlement.refundableMinor,
      refundsWritten: outcome.refundsWritten,
    };
  }
}
