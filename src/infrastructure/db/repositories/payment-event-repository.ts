import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type {
  IncomingPaymentEvent,
  PaymentEventOutcome,
  PaymentEventRepository,
} from '../../../application/ports/repositories.js';

interface EventRow {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount_minor: number;
  currency: string;
  occurred_at: Date;
  payload: unknown;
}

function toEvent(row: EventRow): IncomingPaymentEvent {
  return {
    eventId: row.event_id,
    orderId: row.order_id,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at,
    payload: row.payload,
  };
}

export class PgPaymentEventRepository implements PaymentEventRepository {
  /**
   * Exactly-once, layer one.
   *
   * The primary key on event_id does the arbitration. Fire the same event 50
   * times in parallel and Postgres inserts one row; the other 49 statements
   * return no rows and their callers stop right there. No application level
   * locking, no read-then-write window.
   */
  async claim(tx: TransactionScope, event: IncomingPaymentEvent): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.eventId,
        event.orderId,
        event.status,
        event.amountMinor,
        event.currency,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markProcessed(tx: TransactionScope, eventId: string, outcome: PaymentEventOutcome): Promise<void> {
    await tx.query(
      `UPDATE payment_events SET processed_at = now(), outcome = $2 WHERE event_id = $1`,
      [eventId, outcome],
    );
  }

  /** Records the outcome without clearing the pending marker. See the port docs. */
  async markDeferred(tx: TransactionScope, eventId: string): Promise<void> {
    await tx.query(`UPDATE payment_events SET outcome = 'deferred' WHERE event_id = $1`, [eventId]);
  }

  async lockIfDeferred(tx: TransactionScope, eventId: string): Promise<IncomingPaymentEvent | null> {
    const result = await tx.query<EventRow>(
      `SELECT event_id, order_id, status, amount_minor, currency, occurred_at, payload
         FROM payment_events
        WHERE event_id = $1 AND processed_at IS NULL
        FOR UPDATE`,
      [eventId],
    );
    const row = result.rows[0];
    return row ? toEvent(row) : null;
  }

  /**
   * Events that arrived before their order existed.
   *
   * The webhook contract demands a fast 200 and allows out of order delivery, so
   * an event for an unknown order is parked rather than rejected. Answering 5xx
   * would work too, but it turns a normal ordering artefact into retry traffic
   * and log noise.
   */
  async findDeferred(exec: Executor, orderId: string): Promise<readonly IncomingPaymentEvent[]> {
    const result = await exec.query<EventRow>(
      `SELECT event_id, order_id, status, amount_minor, currency, occurred_at, payload
         FROM payment_events
        WHERE order_id = $1 AND processed_at IS NULL
        ORDER BY occurred_at, received_at`,
      [orderId],
    );
    return result.rows.map(toEvent);
  }

  async findAnyDeferred(exec: Executor, limit: number): Promise<readonly IncomingPaymentEvent[]> {
    const result = await exec.query<EventRow>(
      `SELECT event_id, order_id, status, amount_minor, currency, occurred_at, payload
         FROM payment_events
        WHERE processed_at IS NULL
        ORDER BY received_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toEvent);
  }
}
