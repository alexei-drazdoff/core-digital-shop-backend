/**
 * Double entry bookkeeping.
 *
 * Every financial fact becomes a group of entries whose signed amounts sum to
 * zero. Building the groups here, as pure data, means the balance property is a
 * consequence of construction rather than something the writer has to remember,
 * and it can be asserted with one SQL sum at any time.
 */
import { randomUUID } from 'node:crypto';

/**
 * Two sides, kept apart on purpose.
 *
 * psp_cash, revenue and refund are the CUSTOMER side: what was taken and what
 * was given back. The assignment's invariant, paid = delivered + refunded,
 * is a statement about these three and nothing else.
 *
 * cogs, supplier_payable and shrinkage are the SUPPLIER side: what the goods
 * cost. Mixing the two would let a shortfall on one be absorbed by the other,
 * which is exactly the kind of books that balance and still hide a loss.
 */
export const LEDGER_ACCOUNTS = [
  'psp_cash',
  'revenue',
  'refund',
  'cogs',
  'supplier_payable',
  'shrinkage',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export interface LedgerEntry {
  readonly groupId: string;
  readonly orderId: string;
  /** The line the fact belongs to. Null for facts about the whole basket, like a payment. */
  readonly orderItemId: string | null;
  readonly account: LedgerAccount;
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: number;
  readonly currency: string;
  /** Identifies the real world fact, so the same fact is never journalled twice. */
  readonly refType: string;
  readonly refId: string;
}

export class UnbalancedLedgerGroupError extends Error {
  constructor(delta: number) {
    super(`ledger group does not balance, signed total is ${delta}`);
    this.name = 'UnbalancedLedgerGroupError';
  }
}

function signed(entry: LedgerEntry): number {
  return entry.direction === 'debit' ? entry.amountMinor : -entry.amountMinor;
}

/** Refuses to hand back a group that does not balance, so an unbalanced group can never reach the database. */
export function assertBalanced(entries: readonly LedgerEntry[]): readonly LedgerEntry[] {
  const delta = entries.reduce((total, entry) => total + signed(entry), 0);
  if (delta !== 0) throw new UnbalancedLedgerGroupError(delta);
  return entries;
}

/**
 * Payment captured. Money arrives at the provider and is recognised as revenue.
 * refId is the payment event id, so replaying that event journals nothing new.
 */
export function paymentCapturedEntries(input: {
  orderId: string;
  amountMinor: number;
  currency: string;
  eventId: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = {
    groupId,
    orderId: input.orderId,
    // A payment is a fact about the basket, not about any one line: the customer
    // paid once for the whole thing and the split across lines is decided later.
    orderItemId: null,
    currency: input.currency,
    refType: 'payment_event',
    refId: input.eventId,
  };
  return assertBalanced([
    { ...shared, account: 'psp_cash', direction: 'debit', amountMinor: input.amountMinor },
    { ...shared, account: 'revenue', direction: 'credit', amountMinor: input.amountMinor },
  ]);
}

/**
 * Money returned for a line that could not be delivered.
 *
 * Debit `refund` (a contra-revenue account) and credit `psp_cash`, so the cash
 * held at the provider drops by exactly what went back and the revenue that
 * remains recognised is the revenue actually earned. Net revenue is therefore
 * -(revenue + refund), which for a settled order equals the sum of the delivered
 * lines. That identity is the assignment's "оплачено = выдано + возвращено", and
 * it is a query rather than a promise.
 *
 * refId is the order item id, so the fact is "this line was refunded" and the
 * existing uniqueness on (ref_type, ref_id, account, direction) makes replaying
 * a refund job a no-op without any bookkeeping of its own.
 */
export function refundEntries(input: {
  orderId: string;
  orderItemId: string;
  amountMinor: number;
  currency: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = {
    groupId,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    currency: input.currency,
    refType: 'refund',
    refId: input.orderItemId,
  };
  return assertBalanced([
    { ...shared, account: 'refund', direction: 'debit', amountMinor: input.amountMinor },
    { ...shared, account: 'psp_cash', direction: 'credit', amountMinor: input.amountMinor },
  ]);
}

/**
 * Code handed to the customer. Stock becomes cost of goods sold and a liability
 * towards the supplier. refId is the supplier request id, which is stable across
 * retries, so a retried delivery cannot double count the cost.
 */
export function deliveryCostEntries(input: {
  orderId: string;
  orderItemId: string;
  costMinor: number;
  currency: string;
  requestId: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = {
    groupId,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    currency: input.currency,
    refType: 'delivery',
    refId: input.requestId,
  };
  return assertBalanced([
    { ...shared, account: 'cogs', direction: 'debit', amountMinor: input.costMinor },
    { ...shared, account: 'supplier_payable', direction: 'credit', amountMinor: input.costMinor },
  ]);
}

/**
 * An orphaned issuance: a supplier consumed a key for a call whose response was
 * lost, and the order was served from elsewhere. The stock is gone with no sale
 * behind it, so it is written off as shrinkage rather than quietly dropped. This
 * is what keeps the journal balanced in the exact case the timeout trap creates.
 */
export function orphanIssuanceEntries(input: {
  orderId: string;
  orderItemId: string;
  costMinor: number;
  currency: string;
  requestId: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = {
    groupId,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    currency: input.currency,
    refType: 'orphan_issuance',
    refId: input.requestId,
  };
  return assertBalanced([
    { ...shared, account: 'shrinkage', direction: 'debit', amountMinor: input.costMinor },
    { ...shared, account: 'supplier_payable', direction: 'credit', amountMinor: input.costMinor },
  ]);
}
