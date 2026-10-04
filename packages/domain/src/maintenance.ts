/**
 * Maintenance jobs — nightly background work (§49.2, §64.1, §45.3).
 *
 * 1. Trash auto-cleanup: hard-delete items in Trash for > 30 days.
 * 2. Tombstone cleanup: remove sync tombstones older than 180 days.
 * 3. Idempotency key cleanup: remove keys older than 7 days.
 * 4. Balance reconciliation: recompute account balances and alert on drift.
 * 5. Export expiry: mark ready exports older than 24 hours as expired.
 */

import { and, eq, lt, lte, isNotNull, isNull, sql, ne } from 'drizzle-orm';
import {
  entities,
  notes,
  tasks,
  reminders,
  learningCollections,
  learningResources,
  people,
  financeAccounts,
  financeCategories,
  debts,
  financeTransactions,
  idempotencyKeys,
  exportJobs,
  type Database,
  type Transaction,
} from '@personalspace/db';

/** Hard-delete items that have been in Trash (deletedAt set) for > 30 days. */
export async function cleanupTrash(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  // All domain tables have deletedAt and reference entities.
  // We delete from child tables first, then entities.
  const trashedEntities = await db
    .select({ id: entities.id, userId: entities.userId })
    .from(entities)
    .where(and(isNotNull(entities.purgedAt), lte(entities.purgedAt, cutoff)))
    .limit(500);
  if (!trashedEntities.length) return 0;

  const ids = trashedEntities.map((e) => e.id);
  // Delete from all domain tables (order doesn't matter since they reference entities).
  for (const table of [
    notes, tasks, reminders, learningResources, learningCollections,
    financeTransactions, debts, financeCategories, financeAccounts, people,
  ] as const) {
    await db.delete(table).where(sql`${table.id} = ANY(${ids})`);
  }
  // Finally purge the entity row.
  await db.delete(entities).where(sql`${entities.id} = ANY(${ids})`);
  return ids.length;
}

/** Remove sync tombstones older than 180 days (§64.1). */
export async function cleanupTombstones(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000);
  const result = await db
    .delete(entities)
    .where(and(isNotNull(entities.purgedAt), lte(entities.purgedAt, cutoff)))
    .returning({ id: entities.id });
  return result.length;
}

/** Remove expired idempotency keys (> 7 days). */
export async function cleanupIdempotencyKeys(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const result = await db
    .delete(idempotencyKeys)
    .where(lte(idempotencyKeys.createdAt, cutoff))
    .returning({ key: idempotencyKeys.key });
  return result.length;
}

/** Recompute account cached balances from transactions and alert on drift (§45.3). */
export async function reconcileBalances(db: Database): Promise<{ drifts: Array<{ accountId: string; cached: number; computed: number }> }> {
  // Use a raw query for the aggregation to avoid type complexity.
  const rows = await db.execute<{
    account_id: string;
    cached_balance_minor: number;
    computed_balance: number;
  }>(sql`
    WITH effects AS (
      SELECT
        account_id,
        SUM(CASE
          WHEN transaction_type = 'income' THEN amount_minor
          WHEN transaction_type = 'expense' THEN -amount_minor
          WHEN transaction_type = 'transfer' THEN -amount_minor
          WHEN transaction_type = 'adjustment' THEN COALESCE(adjustment_sign, 1) * amount_minor
          WHEN transaction_type = 'lend' THEN -amount_minor
          WHEN transaction_type = 'borrow' THEN amount_minor
          WHEN transaction_type = 'repayment_in' THEN amount_minor
          WHEN transaction_type = 'repayment_out' THEN -amount_minor
          ELSE 0
        END) AS net
      FROM finance_transactions
      WHERE status = 'posted'
      GROUP BY account_id
    ),
    to_effects AS (
      SELECT
        to_account_id AS account_id,
        SUM(COALESCE(to_amount_minor, amount_minor)) AS net
      FROM finance_transactions
      WHERE status = 'posted' AND to_account_id IS NOT NULL AND transaction_type = 'transfer'
      GROUP BY to_account_id
    )
    SELECT
      a.id AS account_id,
      a.cached_balance_minor,
      (a.opening_balance_minor + COALESCE(e.net, 0) + COALESCE(te.net, 0))::bigint AS computed_balance
    FROM finance_accounts a
    LEFT JOIN effects e ON e.account_id = a.id
    LEFT JOIN to_effects te ON te.account_id = a.id
    WHERE a.deleted_at IS NULL
  `);

  const drifts: Array<{ accountId: string; cached: number; computed: number }> = [];
  for (const row of rows.rows) {
    const cached = Number(row.cached_balance_minor);
    const computed = Number(row.computed_balance);
    if (cached !== computed) {
      drifts.push({ accountId: row.account_id, cached, computed });
      // Auto-correct the cached balance.
      await db
        .update(financeAccounts)
        .set({ cachedBalanceMinor: computed, updatedAt: new Date() })
        .where(eq(financeAccounts.id, row.account_id));
    }
  }
  return { drifts };
}

/** Mark export jobs older than 24 hours as expired. */
export async function expireExports(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const result = await db
    .update(exportJobs)
    .set({ status: 'expired' })
    .where(and(eq(exportJobs.status, 'ready'), lte(exportJobs.completedAt, cutoff)))
    .returning({ id: exportJobs.id });
  return result.length;
}
