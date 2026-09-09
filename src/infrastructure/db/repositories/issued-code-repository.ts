import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type {
  CodeDisposition,
  IssuedCodeRecord,
  IssuedCodeRepository,
} from '../../../application/ports/repositories.js';

const COLUMNS = 'code, supplier, request_id, order_item_id, order_id, disposition, reason, created_at';

interface IssuedCodeRow {
  code: string;
  supplier: string;
  request_id: string;
  order_item_id: string | null;
  order_id: string | null;
  disposition: CodeDisposition;
  reason: string | null;
  created_at: Date;
}

function toRecord(row: IssuedCodeRow): IssuedCodeRecord {
  return {
    code: row.code,
    supplier: row.supplier,
    requestId: row.request_id,
    orderItemId: row.order_item_id,
    orderId: row.order_id,
    disposition: row.disposition,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class PgIssuedCodeRepository implements IssuedCodeRepository {
  /**
   * Claims a code for one purpose, once.
   *
   * The primary key on `code` is doing the work. A supplier that hands back a
   * code it already gave somebody else loses here, in the database, rather than
   * in whichever branch of the delivery path happened to look. The caller learns
   * `false` and must treat its code as invalid — it is not surplus stock, it is
   * a claim on stock that belongs to another customer.
   */
  async claim(tx: TransactionScope, record: Omit<IssuedCodeRecord, 'createdAt'>): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO issued_codes (code, supplier, request_id, order_item_id, order_id, disposition, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [
        record.code,
        record.supplier,
        record.requestId,
        record.orderItemId,
        record.orderId,
        record.disposition,
        record.reason,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reclassify(
    tx: TransactionScope,
    code: string,
    disposition: CodeDisposition,
    reason: string | null,
  ): Promise<void> {
    await tx.query(`UPDATE issued_codes SET disposition = $2, reason = $3 WHERE code = $1`, [
      code,
      disposition,
      reason,
    ]);
  }

  async find(exec: Executor, code: string): Promise<IssuedCodeRecord | null> {
    const result = await exec.query<IssuedCodeRow>(`SELECT ${COLUMNS} FROM issued_codes WHERE code = $1`, [code]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async quarantined(exec: Executor, limit: number): Promise<readonly IssuedCodeRecord[]> {
    const result = await exec.query<IssuedCodeRow>(
      `SELECT ${COLUMNS} FROM issued_codes
        WHERE disposition = 'quarantined'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toRecord);
  }
}
