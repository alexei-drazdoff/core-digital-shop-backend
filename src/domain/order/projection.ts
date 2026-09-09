/**
 * Rebuilding what an order looked like at a past moment.
 *
 * Task 4's requirement is "по запросу на дату видно, в каком состоянии были
 * заказ и деньги на тот момент", and the only honest way to answer it is to
 * replay the facts rather than to read today's row and subtract. Today's row
 * says what is true now; it has no memory of having been anything else.
 *
 * A pure fold, so the reconstruction can be tested exhaustively without a
 * database and so nothing in it can accidentally consult the present.
 *
 * One rule governs the whole file: an event is visible if we had RECORDED it by
 * the cut-off, not if it had happened by then. A webhook that arrived at 12:05
 * describing a payment at 11:55 was not something we knew at 12:00, and a
 * history that pretended otherwise would retroactively know the future — which
 * is the same thing "задним числом ничего не переписывается" forbids, just
 * arrived at by reading rather than by writing.
 */

export const ORDER_EVENT_TYPES = [
  'order_created',
  'payment_captured',
  'payment_failed',
  'item_delivering',
  'item_delivered',
  'item_refunded',
  'code_quarantined',
  'order_settled',
] as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

export interface OrderEvent {
  readonly id: number;
  readonly orderId: string;
  readonly orderItemId: string | null;
  readonly type: OrderEventType | string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  /** When WE learned it. The fold keys off this, never off occurredAt. */
  readonly recordedAt: Date;
}

export interface ItemSnapshot {
  readonly orderItemId: string;
  readonly sku: string;
  readonly priceMinor: number;
  readonly status: string;
  readonly supplier: string | null;
  readonly hasCode: boolean;
}

export interface OrderSnapshot {
  readonly orderId: string;
  readonly asOf: Date;
  /** Null when the order did not exist yet at that moment. */
  readonly status: string | null;
  readonly amountMinor: number;
  readonly paidMinor: number;
  readonly deliveredMinor: number;
  readonly refundedMinor: number;
  /** Paid but not yet resolved either way. Zero for a finished order. */
  readonly unresolvedMinor: number;
  readonly items: readonly ItemSnapshot[];
  readonly eventsApplied: number;
}

function numberFrom(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Folds the events of ONE order into the state it was in at `asOf`.
 *
 * Events after the cut-off are ignored rather than filtered out by the caller,
 * so a caller that fetches a whole history and asks about three different
 * moments gets three correct answers from one read.
 */
export function projectOrderAt(
  orderId: string,
  events: readonly OrderEvent[],
  asOf: Date,
): OrderSnapshot {
  const cutoff = asOf.getTime();
  const items = new Map<string, { sku: string; priceMinor: number; status: string; supplier: string | null; hasCode: boolean }>();

  let status: string | null = null;
  let amountMinor = 0;
  let paidMinor = 0;
  let applied = 0;

  for (const event of events) {
    if (event.recordedAt.getTime() > cutoff) continue;
    applied += 1;

    switch (event.type) {
      case 'order_created': {
        status = 'created';
        amountMinor = numberFrom(event.payload['amountMinor']);
        const lines = Array.isArray(event.payload['items']) ? event.payload['items'] : [];
        for (const line of lines as Array<Record<string, unknown>>) {
          const id = stringFrom(line['orderItemId']);
          if (!id) continue;
          items.set(id, {
            sku: stringFrom(line['sku']) ?? '',
            priceMinor: numberFrom(line['priceMinor']),
            status: 'pending',
            supplier: null,
            hasCode: false,
          });
        }
        break;
      }

      case 'payment_captured':
        status = 'paid';
        paidMinor = numberFrom(event.payload['amountMinor'], amountMinor);
        break;

      case 'payment_failed':
        status = 'payment_failed';
        break;

      case 'item_delivering':
      case 'item_delivered':
      case 'item_refunded': {
        const id = event.orderItemId;
        if (!id) break;
        const line = items.get(id);
        // A line the creation event never mentioned. Recorded rather than
        // dropped: an incomplete history should be visibly incomplete, not
        // silently smoothed over.
        const next = line ?? {
          sku: stringFrom(event.payload['sku']) ?? '',
          priceMinor: numberFrom(event.payload['priceMinor']),
          status: 'pending',
          supplier: null,
          hasCode: false,
        };
        items.set(id, {
          ...next,
          status:
            event.type === 'item_delivered'
              ? 'delivered'
              : event.type === 'item_refunded'
                ? 'refunded'
                : 'delivering',
          supplier: stringFrom(event.payload['supplier']) ?? next.supplier,
          hasCode: event.type === 'item_delivered' ? true : next.hasCode,
        });
        break;
      }

      case 'order_settled':
        status = stringFrom(event.payload['status']) ?? status;
        break;

      // code_quarantined and anything a later version adds are recorded facts
      // that do not move the order's state. Counted as applied, so a reader can
      // still tell that something happened, but deliberately not interpreted:
      // an old projection must not guess at the meaning of a new event.
      default:
        break;
    }
  }

  const snapshot = [...items.entries()].map(([orderItemId, line]) => ({ orderItemId, ...line }));
  const deliveredMinor = snapshot
    .filter((line) => line.status === 'delivered')
    .reduce((total, line) => total + line.priceMinor, 0);
  const refundedMinor = snapshot
    .filter((line) => line.status === 'refunded')
    .reduce((total, line) => total + line.priceMinor, 0);

  return {
    orderId,
    asOf,
    status,
    amountMinor,
    paidMinor,
    deliveredMinor,
    refundedMinor,
    // What the customer had paid for and not yet received, at that moment. The
    // money invariant, evaluated in the past: paid = delivered + refunded +
    // unresolved holds at every point in the history, not only at the end.
    unresolvedMinor: paidMinor - deliveredMinor - refundedMinor,
    items: snapshot,
    eventsApplied: applied,
  };
}
