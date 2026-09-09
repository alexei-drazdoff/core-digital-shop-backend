/**
 * What a partially fulfilled order owes, as arithmetic.
 *
 * The assignment's hard requirement is "по деньгам всегда сходится: оплачено
 * равно выдано плюс возвращено". That sentence is only worth anything if it is a
 * computation somebody can run, so it lives here as a pure function over line
 * outcomes and is asserted rather than assumed everywhere money is written.
 *
 * Two sides of the books are deliberately NOT mixed:
 *
 *   the customer side, psp_cash / revenue / refund, where this invariant lives.
 *   Every minor unit the customer paid is either sitting behind a delivered line
 *   or has been given back.
 *
 *   the supplier side, cogs / supplier_payable / shrinkage, which records what
 *   the goods cost us. It is its own balanced pair and has nothing to say about
 *   whether the customer was treated correctly.
 *
 * Conflating them yields an invariant that looks rigorous and proves nothing,
 * because a shortfall on one side can be silently absorbed by the other.
 */
import type { OrderItemStatus } from './status.js';

export interface SettlementLine {
  readonly id: string;
  readonly status: OrderItemStatus;
  readonly priceMinor: number;
}

export interface Settlement {
  /** What the customer paid for the whole basket. */
  readonly paidMinor: number;
  /** Sum of the lines the customer actually received. */
  readonly deliveredMinor: number;
  /** Sum of the lines the customer must get back. */
  readonly refundableMinor: number;
  /** Lines still in flight. Non-zero means the order is not finished yet. */
  readonly unresolvedMinor: number;
  readonly balances: boolean;
}

export class UnbalancedSettlementError extends Error {
  constructor(
    readonly orderId: string,
    readonly settlement: Settlement,
  ) {
    super(
      `order ${orderId} does not settle: paid ${settlement.paidMinor} != delivered ${settlement.deliveredMinor}` +
        ` + refunded ${settlement.refundableMinor} + unresolved ${settlement.unresolvedMinor}`,
    );
    this.name = 'UnbalancedSettlementError';
  }
}

/**
 * Splits the paid amount across the three possible fates of a line.
 *
 * `balances` is the whole point: paid must equal delivered plus refundable plus
 * whatever is still unresolved. It can only be false when the sum of the lines
 * disagrees with the order total, which means the basket was priced wrong at
 * creation, and that is a defect worth refusing to write money against.
 */
export function settle(paidMinor: number, lines: readonly SettlementLine[]): Settlement {
  let deliveredMinor = 0;
  let refundableMinor = 0;
  let unresolvedMinor = 0;

  for (const line of lines) {
    if (line.status === 'delivered') deliveredMinor += line.priceMinor;
    else if (line.status === 'refunded') refundableMinor += line.priceMinor;
    else unresolvedMinor += line.priceMinor;
  }

  return {
    paidMinor,
    deliveredMinor,
    refundableMinor,
    unresolvedMinor,
    balances: paidMinor === deliveredMinor + refundableMinor + unresolvedMinor,
  };
}

/** Refuses to let an unbalanced settlement reach the money journal. */
export function assertSettles(orderId: string, settlement: Settlement): Settlement {
  if (!settlement.balances) throw new UnbalancedSettlementError(orderId, settlement);
  return settlement;
}
