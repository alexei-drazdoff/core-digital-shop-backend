import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type {
  DeliveryRecord,
  DeliveryRepository,
  SupplierRequestRecord,
  SupplierRequestRepository,
  SupplierRequestState,
} from '../../../application/ports/repositories.js';

interface SupplierRequestRow {
  request_id: string;
  order_id: string;
  order_item_id: string;
  supplier: string;
  epoch: number;
  state: SupplierRequestState;
  code: string | null;
  failure_reason: string | null;
  attempts: number;
  last_sent_at: Date;
}

function toRequest(row: SupplierRequestRow): SupplierRequestRecord {
  return {
    requestId: row.request_id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    supplier: row.supplier,
    epoch: row.epoch,
    state: row.state,
    code: row.code,
    failureReason: row.failure_reason,
    attempts: row.attempts,
    lastSentAt: row.last_sent_at,
  };
}

const REQUEST_COLUMNS =
  'request_id, order_id, order_item_id, supplier, epoch, state, code, failure_reason, attempts, last_sent_at';

export class PgSupplierRequestRepository implements SupplierRequestRepository {
  /**
   * Writes the intent to call a supplier before the call happens.
   *
   * This is what makes an interrupted call recoverable at all. If the process
   * dies between the HTTP request and its response, the only evidence that a
   * side effect may exist is this row, and without it a crashed delivery would
   * be indistinguishable from one that never started.
   *
   * Only a succeeded request is sticky. A refusal is definitive for the attempt
   * that received it, not for all time: stock gets replenished and suppliers
   * recover, so a later attempt must be able to re-open the request. Re-asking
   * with the same request id stays safe because the contract binds one code to
   * one request id, whether that code already exists or is minted now.
   */
  async beginAttempt(
    exec: Executor,
    request: { requestId: string; orderId: string; orderItemId: string; supplier: string; epoch: number },
  ): Promise<SupplierRequestRecord> {
    const result = await exec.query<SupplierRequestRow>(
      `INSERT INTO supplier_requests
         (request_id, order_id, order_item_id, supplier, epoch, state, attempts, first_sent_at, last_sent_at)
       VALUES ($1, $2, $3, $4, $5, 'in_flight', 1, now(), now())
       ON CONFLICT (request_id) DO UPDATE
          SET attempts = supplier_requests.attempts + 1,
              last_sent_at = now(),
              -- A succeeded request keeps its code forever. Anything else re-opens,
              -- which is what makes out_of_stock and delivery_failed recoverable.
              state = CASE WHEN supplier_requests.state = 'succeeded'
                           THEN 'succeeded' ELSE 'in_flight' END,
              failure_reason = CASE WHEN supplier_requests.state = 'succeeded'
                                    THEN supplier_requests.failure_reason ELSE NULL END
       RETURNING ${REQUEST_COLUMNS}`,
      [request.requestId, request.orderId, request.orderItemId, request.supplier, request.epoch],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`failed to record supplier request ${request.requestId}`);
    return toRequest(row);
  }

  async settle(
    exec: Executor,
    requestId: string,
    state: SupplierRequestState,
    fields: { code?: string | null; failureReason?: string | null },
  ): Promise<void> {
    await exec.query(
      `UPDATE supplier_requests
          SET state = $2,
              code = COALESCE($3, code),
              failure_reason = $4,
              settled_at = CASE WHEN $2 IN ('succeeded', 'failed_definitive') THEN now() ELSE settled_at END
        WHERE request_id = $1`,
      [requestId, state, fields.code ?? null, fields.failureReason ?? null],
    );
  }

  async find(exec: Executor, requestId: string): Promise<SupplierRequestRecord | null> {
    const result = await exec.query<SupplierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM supplier_requests WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    return row ? toRequest(row) : null;
  }

  async findByOrder(exec: Executor, orderId: string): Promise<readonly SupplierRequestRecord[]> {
    const result = await exec.query<SupplierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM supplier_requests WHERE order_id = $1 ORDER BY first_sent_at`,
      [orderId],
    );
    return result.rows.map(toRequest);
  }

  /**
   * Where delivery should resume for this (line, supplier).
   *
   * Zero means nothing was ever sent. Anything else means an earlier epoch may
   * have left a code stranded at the supplier, so the caller re-enters at that
   * epoch and asks the same question again rather than opening a fresh request
   * and ordering a second code.
   */
  async latestEpoch(exec: Executor, orderItemId: string, supplier: string): Promise<number> {
    const result = await exec.query<{ epoch: number | null }>(
      `SELECT max(epoch) AS epoch FROM supplier_requests WHERE order_item_id = $1 AND supplier = $2`,
      [orderItemId, supplier],
    );
    return result.rows[0]?.epoch ?? 0;
  }

  /** Feeds the background reconciler that chases calls whose fate is still unknown. */
  async findUnsettled(exec: Executor, olderThan: Date, limit: number): Promise<readonly SupplierRequestRecord[]> {
    const result = await exec.query<SupplierRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM supplier_requests
        WHERE state IN ('in_flight', 'unknown') AND last_sent_at < $1
        ORDER BY last_sent_at
        LIMIT $2`,
      [olderThan, limit],
    );
    return result.rows.map(toRequest);
  }

  async recordAttempt(
    exec: Executor,
    attempt: {
      orderId: string;
      orderItemId: string;
      supplier: string;
      requestId: string;
      attemptNo: number;
      outcome: 'issued' | 'refused' | 'timeout' | 'transport_error' | 'circuit_open' | 'rejected';
      latencyMs: number | null;
      error: string | null;
    },
  ): Promise<void> {
    await exec.query(
      `INSERT INTO delivery_attempts (order_id, order_item_id, supplier, request_id, attempt_no, outcome, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        attempt.orderId,
        attempt.orderItemId,
        attempt.supplier,
        attempt.requestId,
        attempt.attemptNo,
        attempt.outcome,
        attempt.latencyMs,
        attempt.error,
      ],
    );
  }
}

const DELIVERY_COLUMNS = 'order_id, order_item_id, supplier, request_id, code, delivered_at';

interface DeliveryRow {
  order_id: string;
  order_item_id: string;
  supplier: string;
  request_id: string;
  code: string;
  delivered_at: Date;
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    supplier: row.supplier,
    requestId: row.request_id,
    code: row.code,
    deliveredAt: row.delivered_at,
  };
}

export class PgDeliveryRepository implements DeliveryRepository {
  /**
   * Exactly-once, layer three, and the only one that is not an argument.
   *
   * UNIQUE (order_item_id) means a second delivery row cannot exist for a line.
   * Whatever went wrong upstream, however many workers or suppliers produced a
   * code, the database admits one delivery per line. A false return tells the
   * caller its code is surplus, which is the signal that turns a potential
   * double issuance into a recorded orphan.
   */
  async recordIfAbsent(tx: TransactionScope, delivery: Omit<DeliveryRecord, 'deliveredAt'>): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO deliveries (order_id, order_item_id, supplier, request_id, code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_item_id) DO NOTHING
       RETURNING id`,
      [delivery.orderId, delivery.orderItemId, delivery.supplier, delivery.requestId, delivery.code],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findByItem(exec: Executor, orderItemId: string): Promise<DeliveryRecord | null> {
    const result = await exec.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE order_item_id = $1`,
      [orderItemId],
    );
    const row = result.rows[0];
    return row ? toDelivery(row) : null;
  }

  async findByOrder(exec: Executor, orderId: string): Promise<readonly DeliveryRecord[]> {
    const result = await exec.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE order_id = $1 ORDER BY delivered_at`,
      [orderId],
    );
    return result.rows.map(toDelivery);
  }

  /**
   * Records stock that a supplier consumed for a call we could not use.
   *
   * Unique on request_id, so the reconciler can run as often as it likes without
   * inflating the write off.
   */
  async recordOrphan(
    tx: TransactionScope,
    orphan: {
      orderId: string;
      orderItemId: string;
      supplier: string;
      requestId: string;
      code: string;
      note: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO orphan_issuances (order_id, order_item_id, supplier, request_id, code, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING id`,
      [orphan.orderId, orphan.orderItemId, orphan.supplier, orphan.requestId, orphan.code, orphan.note],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
