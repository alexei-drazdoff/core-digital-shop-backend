/**
 * The order lifecycle, as a pure state machine.
 *
 * Kept free of IO on purpose: it is the one piece of logic that decides whether
 * money and goods move, so it must be readable and exhaustively testable without
 * a database. Every write path in the application asks this module first.
 *
 * There are two machines now, and the split follows the split in the data. A
 * LINE moves through fulfilment: it is fetched from a supplier, or it is not and
 * the money goes back. An ORDER holds the money and is otherwise a PROJECTION of
 * its lines, which is why `deriveOrderStatus` exists and why nothing writes an
 * order's fulfilment status by hand.
 */

export const ORDER_STATUSES = [
  'created',
  'paid',
  'delivering',
  'delivered',
  'partially_delivered',
  'refunded',
  'payment_failed',
  'out_of_stock',
  'delivery_failed',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'out_of_stock',
  'delivery_failed',
  'refunded',
] as const;

export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

/**
 * No transition leaves these. A late webhook or a duplicate job cannot disturb them.
 *
 * partially_delivered and refunded are terminal for the same reason delivered is:
 * every line has been resolved one way or the other and the money has been
 * settled against those outcomes. There is nothing further to try.
 */
const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  'delivered',
  'partially_delivered',
  'refunded',
  'payment_failed',
]);

/**
 * Paid but undelivered, and safe to retry. These are failures of fulfilment, not
 * of payment, so the customer's money is already ours and the order must be
 * driven forward rather than abandoned.
 */
const RECOVERABLE: ReadonlySet<OrderStatus> = new Set(['out_of_stock', 'delivery_failed']);

const ALLOWED: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['paid', 'payment_failed'],
  paid: ['delivering', 'out_of_stock', 'delivery_failed', 'delivered', 'partially_delivered', 'refunded'],
  // Settlement can land on any of the three outcomes, and can also step back to
  // a recoverable state when some lines still owe the customer a code.
  delivering: ['out_of_stock', 'delivery_failed', 'delivered', 'partially_delivered', 'refunded'],
  // The two recoverable states can succeed each other as different lines of the
  // same basket fail for different reasons, and both re-enter delivery once
  // stock is back or the supplier is healthy again.
  out_of_stock: ['delivering', 'delivery_failed', 'delivered', 'partially_delivered', 'refunded'],
  delivery_failed: ['delivering', 'out_of_stock', 'delivered', 'partially_delivered', 'refunded'],
  delivered: [],
  partially_delivered: [],
  refunded: [],
  payment_failed: [],
};

/** A line that has been resolved: the customer either has the code or has the money. */
const ITEM_RESOLVED: ReadonlySet<OrderItemStatus> = new Set(['delivered', 'refunded']);

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

export function isRecoverable(status: OrderStatus): boolean {
  return RECOVERABLE.has(status);
}

export function isItemResolved(status: OrderItemStatus): boolean {
  return ITEM_RESOLVED.has(status);
}

/** True when the order is paid for and still owes the customer something. */
export function awaitsDelivery(status: OrderStatus): boolean {
  return status === 'paid' || status === 'delivering' || RECOVERABLE.has(status);
}

/** True when the line is paid for and still owes the customer a code. */
export function itemAwaitsDelivery(status: OrderItemStatus): boolean {
  return !ITEM_RESOLVED.has(status);
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

/**
 * The order's fulfilment status, computed from its lines.
 *
 * Deriving rather than storing is what makes "честно: что смогли выдать, то
 * остаётся" checkable. An order cannot claim to be delivered while a line is
 * still pending, and it cannot claim to have failed while a line was handed
 * over, because neither statement is expressible: both come from the same fold.
 *
 * When lines are still open the order reports the WORST open state, not the
 * best. A basket with one delivered line and one out of stock is an out of stock
 * order, because that is the thing somebody has to do something about. For a
 * single line basket this reduces exactly to the first stage's state machine,
 * which is why an order that used to end in `out_of_stock` still does.
 *
 * Returns null only when there is nothing to derive from.
 */
export function deriveOrderStatus(
  items: ReadonlyArray<{ readonly status: OrderItemStatus }>,
): OrderStatus | null {
  if (items.length === 0) return null;

  const open = items.filter((item) => !ITEM_RESOLVED.has(item.status));

  if (open.length === 0) {
    const delivered = items.filter((item) => item.status === 'delivered').length;
    if (delivered === items.length) return 'delivered';
    if (delivered === 0) return 'refunded';
    return 'partially_delivered';
  }

  // Ordered by how much attention the state deserves. delivery_failed outranks
  // out_of_stock because a sick supplier is a wider problem than a missing key,
  // and both outrank a line merely waiting its turn.
  if (open.some((item) => item.status === 'delivery_failed')) return 'delivery_failed';
  if (open.some((item) => item.status === 'out_of_stock')) return 'out_of_stock';
  if (open.some((item) => item.status === 'delivering')) return 'delivering';
  // Everything still pending: the order has been paid for and nothing has been
  // attempted, which is what `paid` already says. Nothing to change.
  return null;
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
