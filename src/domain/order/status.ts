/**
 * The order lifecycle, as a pure state machine.
 *
 * Kept free of IO on purpose: it is the one piece of logic that decides whether
 * money and goods move, so it must be readable and exhaustively testable without
 * a database. Every write path in the application asks this module first.
 */

export const ORDER_STATUSES = [
  'created',
  'paid',
  'delivering',
  'delivered',
  'payment_failed',
  'out_of_stock',
  'delivery_failed',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** No transition leaves these. A late webhook or a duplicate job cannot disturb them. */
const TERMINAL: ReadonlySet<OrderStatus> = new Set(['delivered', 'payment_failed']);

/**
 * Paid but undelivered, and safe to retry. These are failures of fulfilment, not
 * of payment, so the customer's money is already ours and the order must be
 * driven forward rather than abandoned.
 */
const RECOVERABLE: ReadonlySet<OrderStatus> = new Set(['out_of_stock', 'delivery_failed']);

const ALLOWED: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['paid', 'payment_failed'],
  paid: ['delivering'],
  delivering: ['delivered', 'out_of_stock', 'delivery_failed'],
  // Recovery re-enters delivery once stock is back or the supplier is healthy again.
  out_of_stock: ['delivering'],
  delivery_failed: ['delivering'],
  delivered: [],
  payment_failed: [],
};

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

export function isRecoverable(status: OrderStatus): boolean {
  return RECOVERABLE.has(status);
}

/** True when the order is paid for and still owes the customer a code. */
export function awaitsDelivery(status: OrderStatus): boolean {
  return status === 'paid' || status === 'delivering' || RECOVERABLE.has(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`cannot move order from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export type PaymentEventStatus = 'paid' | 'failed';

export type PaymentDecision =
  | { readonly kind: 'apply'; readonly nextStatus: OrderStatus }
  /** The order already moved past this point; recording the event is all that is left. */
  | { readonly kind: 'ignore'; readonly outcome: 'ignored_stale' | 'ignored_terminal' };

/**
 * Decides what an incoming payment event should do to an order in `current`.
 *
 * Being a decision function rather than a mutation is what makes the concurrent
 * webhook case tractable: 50 callers can each ask, and the answer only becomes a
 * write for the one whose conditional UPDATE actually matches a row.
 */
export function decidePaymentEffect(current: OrderStatus, event: PaymentEventStatus): PaymentDecision {
  if (isTerminal(current)) {
    return { kind: 'ignore', outcome: 'ignored_terminal' };
  }
  if (event === 'failed') {
    // A failure only counts while the order is still awaiting payment. Once
    // delivery is under way the money is confirmed, so a late failure event is
    // stale rather than authoritative.
    return current === 'created'
      ? { kind: 'apply', nextStatus: 'payment_failed' }
      : { kind: 'ignore', outcome: 'ignored_stale' };
  }
  return current === 'created'
    ? { kind: 'apply', nextStatus: 'paid' }
    : { kind: 'ignore', outcome: 'ignored_stale' };
}
