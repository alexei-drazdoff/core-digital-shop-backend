/**
 * Key pool and issuance bookkeeping for a supplier stub.
 *
 * The one rule that matters: an issuance is keyed by request_id, so repeating a
 * call with the same request_id returns the code that was already issued. That
 * is what the supplier contract promises and what makes a retry after a timeout
 * safe for the caller.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from '../../infrastructure/db/pool.js';

/** Retries that only distinguish a contended pool from an empty one. */
const CONTENTION_ATTEMPTS = 5;
const CONTENTION_BACKOFF_MS = 10;

export interface Issuance {
  readonly requestId: string;
  readonly code: string;
  /** True when this call minted the code, false when an earlier call already had. */
  readonly fresh: boolean;
}

export class OutOfStockError extends Error {
  constructor(sku: string) {
    super(`no keys available for sku ${sku}`);
    this.name = 'OutOfStockError';
  }
}

export interface ChaosConfig {
  errorRate: number;
  timeoutRate: number;
  latencyMs: number;
  hangMs: number;
  issueBeforeHang: boolean;
  hangBeforeLookup: boolean;
  forcedOutcome: 'ok' | 'error' | 'timeout' | 'out_of_stock' | null;
}

export class SupplierStore {
  constructor(
    private readonly pool: Pool,
    private readonly supplier: string,
  ) {}

  /**
   * Allocates a key for (request_id, sku), or returns the one already allocated.
   *
   * Two different races have to be handled and they need different tools.
   *
   * Same request_id arriving concurrently: an advisory lock keyed on the
   * request_id serialises them, so the first call allocates and the rest read
   * back its code. Without it the losers would skip past the locked key row and
   * wrongly report out_of_stock while stock clearly existed.
   *
   * Different request_ids competing for the same SKU: SKIP LOCKED keeps them
   * from queueing behind one another, but an empty result then means either a
   * genuinely empty pool or merely a contended one. Those are distinguished by
   * counting what remains before answering, because reporting out_of_stock when
   * stock exists would push a paid order into recovery for no reason.
   */
  async issue(requestId: string, orderId: string, sku: string): Promise<Issuance> {
    const existing = await this.findIssuance(requestId);
    if (existing) return { ...existing, fresh: false };

    for (let attempt = 1; attempt <= CONTENTION_ATTEMPTS; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Serialises concurrent calls that share a request_id. Released on COMMIT
        // or ROLLBACK, so no lock can outlive its transaction.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [requestId]);

        // Re-read under the lock: a concurrent call may have issued while we waited.
        const alreadyIssued = await client.query<{ code: string }>(
          `SELECT code FROM supplier_stub.issuances WHERE request_id = $1 AND supplier = $2`,
          [requestId, this.supplier],
        );
        const winner = alreadyIssued.rows[0];
        if (winner) {
          await client.query('ROLLBACK');
          return { requestId, code: winner.code, fresh: false };
        }

        const key = await client.query<{ id: number; code: string }>(
          `SELECT id, code FROM supplier_stub.keys
            WHERE supplier = $1 AND sku = $2 AND state = 'available'
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [this.supplier, sku],
        );
        const row = key.rows[0];

        if (!row) {
          const remaining = await client.query<{ available: number }>(
            `SELECT count(*)::int AS available FROM supplier_stub.keys
              WHERE supplier = $1 AND sku = $2 AND state = 'available'`,
            [this.supplier, sku],
          );
          await client.query('ROLLBACK');
          if ((remaining.rows[0]?.available ?? 0) === 0) throw new OutOfStockError(sku);
          // Stock exists but every free row is locked by a peer. Back off and retry.
          await sleep(CONTENTION_BACKOFF_MS * attempt);
          continue;
        }

        await client.query(`UPDATE supplier_stub.keys SET state = 'issued' WHERE id = $1`, [row.id]);
        const inserted = await client.query<{ request_id: string }>(
          `INSERT INTO supplier_stub.issuances (request_id, supplier, order_id, sku, code, key_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (request_id) DO NOTHING
           RETURNING request_id`,
          [requestId, this.supplier, orderId, sku, row.code, row.id],
        );

        if (inserted.rowCount === 0) {
          // Advisory locks are cooperative, so the primary key stays as the real
          // backstop. Rolling back returns the key we took to the pool.
          await client.query('ROLLBACK');
          const settled = await this.findIssuance(requestId);
          if (!settled) throw new Error(`lost the issuance race for ${requestId} but found no winner`);
          return { ...settled, fresh: false };
        }

        await client.query('COMMIT');
        return { requestId, code: row.code, fresh: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    throw new OutOfStockError(sku);
  }

  async findIssuance(requestId: string): Promise<{ requestId: string; code: string } | null> {
    const result = await this.pool.query<{ request_id: string; code: string }>(
      `SELECT request_id, code FROM supplier_stub.issuances WHERE request_id = $1 AND supplier = $2`,
      [requestId, this.supplier],
    );
    const row = result.rows[0];
    return row ? { requestId: row.request_id, code: row.code } : null;
  }

  async issuancesForOrder(orderId: string): Promise<Array<{ requestId: string; code: string; createdAt: Date }>> {
    const result = await this.pool.query<{ request_id: string; code: string; created_at: Date }>(
      `SELECT request_id, code, created_at FROM supplier_stub.issuances
        WHERE order_id = $1 AND supplier = $2 ORDER BY created_at`,
      [orderId, this.supplier],
    );
    return result.rows.map((row) => ({ requestId: row.request_id, code: row.code, createdAt: row.created_at }));
  }

  async stock(): Promise<Array<{ sku: string; available: number }>> {
    const result = await this.pool.query<{ sku: string; available: number }>(
      `SELECT sku, count(*)::int AS available FROM supplier_stub.keys
        WHERE supplier = $1 AND state = 'available' GROUP BY sku ORDER BY sku`,
      [this.supplier],
    );
    return result.rows;
  }

  /** Adds fresh keys to the pool. Used to exercise recovery from out_of_stock. */
  async replenish(sku: string, codes: readonly string[]): Promise<number> {
    if (codes.length === 0) return 0;
    const result = await this.pool.query(
      `INSERT INTO supplier_stub.keys (supplier, sku, code)
       SELECT $1, $2, unnest($3::text[])
       ON CONFLICT (supplier, code) DO NOTHING`,
      [this.supplier, sku, codes],
    );
    return result.rowCount ?? 0;
  }

  async getChaos(): Promise<ChaosConfig> {
    const result = await this.pool.query<{
      error_rate: number;
      timeout_rate: number;
      latency_ms: number;
      hang_ms: number;
      issue_before_hang: boolean;
      hang_before_lookup: boolean;
      forced_outcome: ChaosConfig['forcedOutcome'];
    }>(`SELECT * FROM supplier_stub.chaos WHERE supplier = $1`, [this.supplier]);
    const row = result.rows[0];
    if (!row) {
      return {
        errorRate: 0,
        timeoutRate: 0,
        latencyMs: 0,
        hangMs: 30_000,
        issueBeforeHang: true,
        hangBeforeLookup: false,
        forcedOutcome: null,
      };
    }
    return {
      errorRate: Number(row.error_rate),
      timeoutRate: Number(row.timeout_rate),
      latencyMs: row.latency_ms,
      hangMs: row.hang_ms,
      issueBeforeHang: row.issue_before_hang,
      hangBeforeLookup: row.hang_before_lookup,
      forcedOutcome: row.forced_outcome,
    };
  }

  async setChaos(patch: Partial<ChaosConfig>): Promise<ChaosConfig> {
    const current = await this.getChaos();
    const next = { ...current, ...patch };
    await this.pool.query(
      `INSERT INTO supplier_stub.chaos
         (supplier, error_rate, timeout_rate, latency_ms, hang_ms, issue_before_hang, hang_before_lookup, forced_outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (supplier) DO UPDATE SET
         error_rate = EXCLUDED.error_rate,
         timeout_rate = EXCLUDED.timeout_rate,
         latency_ms = EXCLUDED.latency_ms,
         hang_ms = EXCLUDED.hang_ms,
         issue_before_hang = EXCLUDED.issue_before_hang,
         hang_before_lookup = EXCLUDED.hang_before_lookup,
         forced_outcome = EXCLUDED.forced_outcome`,
      [
        this.supplier,
        next.errorRate,
        next.timeoutRate,
        next.latencyMs,
        next.hangMs,
        next.issueBeforeHang,
        next.hangBeforeLookup,
        next.forcedOutcome,
      ],
    );
    return next;
  }
}
