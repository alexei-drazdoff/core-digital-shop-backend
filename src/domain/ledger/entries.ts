/**
 * Double entry bookkeeping.
 *
 * Every financial fact becomes a group of entries whose signed amounts sum to
 * zero. Building the groups here, as pure data, means the balance property is a
 * consequence of construction rather than something the writer has to remember,
 * and it can be asserted with one SQL sum at any time.
 */
import { randomUUID } from 'node:crypto';

export const LEDGER_ACCOUNTS = ['psp_cash', 'revenue', 'cogs', 'supplier_payable', 'shrinkage'] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export interface LedgerEntry {
  readonly groupId: string;
  readonly orderId: string;
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
  const shared = { groupId, orderId: input.orderId, currency: input.currency, refType: 'payment_event', refId: input.eventId };
  return assertBalanced([
    { ...shared, account: 'psp_cash', direction: 'debit', amountMinor: input.amountMinor },
    { ...shared, account: 'revenue', direction: 'credit', amountMinor: input.amountMinor },
  ]);
}

/**
 * Code handed to the customer. Stock becomes cost of goods sold and a liability
 * towards the supplier. refId is the supplier request id, which is stable across
 * retries, so a retried delivery cannot double count the cost.
 */
export function deliveryCostEntries(input: {
  orderId: string;
  costMinor: number;
  currency: string;
  requestId: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = { groupId, orderId: input.orderId, currency: input.currency, refType: 'delivery', refId: input.requestId };
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
  costMinor: number;
  currency: string;
  requestId: string;
}): readonly LedgerEntry[] {
  const groupId = randomUUID();
  const shared = { groupId, orderId: input.orderId, currency: input.currency, refType: 'orphan_issuance', refId: input.requestId };
  return assertBalanced([
    { ...shared, account: 'shrinkage', direction: 'debit', amountMinor: input.costMinor },
    { ...shared, account: 'supplier_payable', direction: 'credit', amountMinor: input.costMinor },
  ]);
}
