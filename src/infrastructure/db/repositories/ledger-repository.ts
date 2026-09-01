import type { Executor } from '../pool.js';
import type { TransactionScope } from '../unit-of-work.js';
import type { LedgerEntry } from '../../../domain/ledger/entries.js';
import type { LedgerRepository } from '../../../application/ports/repositories.js';

export class PgLedgerRepository implements LedgerRepository {
  /**
   * Appends a balanced group.
   *
   * ON CONFLICT DO NOTHING against the (ref_type, ref_id, account, direction)
   * constraint is what makes the journal safe to write from an at-least-once
   * job: replaying the same real world fact adds nothing, so the accounts cannot
   * drift no matter how often a worker retries.
   */
  async append(tx: TransactionScope, entries: readonly LedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const values: unknown[] = [];
    const tuples = entries.map((entry, index) => {
      const base = index * 8;
      values.push(
        entry.groupId,
        entry.orderId,
        entry.account,
        entry.direction,
        entry.amountMinor,
        entry.currency,
        entry.refType,
        entry.refId,
      );
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    await tx.query(
      `INSERT INTO ledger_entries (group_id, order_id, account, direction, amount_minor, currency, ref_type, ref_id)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (ref_type, ref_id, account, direction) DO NOTHING`,
      values,
    );
  }

  async balanceByAccount(exec: Executor): Promise<ReadonlyArray<{ account: string; signedMinor: number }>> {
    const result = await exec.query<{ account: string; signed_minor: number }>(
      `SELECT account, COALESCE(SUM(signed_minor), 0)::bigint AS signed_minor
         FROM ledger_entries GROUP BY account ORDER BY account`,
    );
    return result.rows.map((row) => ({ account: row.account, signedMinor: Number(row.signed_minor) }));
  }

  /**
   * Groups whose signed amounts do not sum to zero.
   *
   * This is the invariant made checkable. It should always return nothing; if it
   * ever returns a row, the journal has a hole and the reconciliation endpoint
   * says so instead of quietly reporting healthy.
   */
  async unbalancedGroups(exec: Executor): Promise<ReadonlyArray<{ groupId: string; signedMinor: number }>> {
    const result = await exec.query<{ group_id: string; signed_minor: number }>(
      `SELECT group_id, SUM(signed_minor)::bigint AS signed_minor
         FROM ledger_entries
        GROUP BY group_id
       HAVING SUM(signed_minor) <> 0`,
    );
    return result.rows.map((row) => ({ groupId: row.group_id, signedMinor: Number(row.signed_minor) }));
  }
}
