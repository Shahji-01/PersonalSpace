/**
 * Maintenance jobs — nightly background work (§49.2, §64.1, §45.3).
 *
 * 1. Trash auto-cleanup: hard-delete items in Trash for > 30 days.
 * 2. Preserve UUID reservations for full sync recovery and offline retries.
 * 3. Compact cached retry responses after 7 days, retaining deduplication keys.
 * 4. Balance reconciliation: recompute account balances and alert on drift.
 * 5. Export expiry: mark ready exports older than 24 hours as expired.
 */

import { v7 } from 'uuid';
import { and, eq, inArray, lte, isNull, or, sql } from 'drizzle-orm';
import {
  entities,
  tasks,
  syncState,
  auditLogs,
  outboxEvents,
  exportJobs,
  withUser,
  type Database,
} from '@personalspace/db';
import { purgeRecords } from './capture';
import { nextVersion } from './capture.repository';
import { indexSearchRecords } from './search';

/** Bounded content erasure, serialized with restores and all other account mutations. */
export async function cleanupTrash(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const eligible = and(
    isNull(entities.purgedAt),
    lte(entities.deletedAt, cutoff),
    // Financial rows and containers have different, explicit deletion workflows.
    inArray(entities.type, ['note', 'task', 'inbox', 'reminder', 'learning_resource']),
    sql`NOT EXISTS (SELECT 1 FROM deletion_requests d WHERE d.user_id = ${entities.userId}
      AND (d.status IN ('processing', 'completed') OR d.started_at IS NOT NULL))`,
  );
  const trashedEntities = await db
    .select({ id: entities.id, userId: entities.userId })
    .from(entities)
    .where(eligible)
    // Visit task children before parents. Otherwise a page full of older parents
    // could keep deferring forever because their eligible children fell on page two.
    .orderBy(
      sql`CASE WHEN ${entities.type} = 'task' AND EXISTS (
        SELECT 1 FROM tasks child WHERE child.user_id = ${entities.userId}
          AND child.parent_id = ${entities.id}
      ) THEN 1 ELSE 0 END`,
      entities.deletedAt,
      entities.id,
    )
    .limit(500);
  let purged = 0;
  for (const userId of new Set(trashedEntities.map((row) => row.userId))) {
    purged += await withUser(db, userId, async (tx) => {
      // Match the domain's first data lock. Recheck after waiting for any restore.
      const [state] = await tx
        .select()
        .from(syncState)
        .where(eq(syncState.userId, userId))
        .for('update');
      if (!state) return 0;
      const rows = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eligible,
            eq(entities.userId, userId),
            inArray(
              entities.id,
              trashedEntities.filter((row) => row.userId === userId).map((row) => row.id),
            ),
          ),
        );
      if (!rows.length) return 0;
      const candidates = new Set(rows.map((row) => row.id));
      const children = await tx
        .select({ id: tasks.id, parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.userId, userId), inArray(tasks.parentId, [...candidates])));
      // Never strand a live/recently trashed child or exceed the candidate page.
      for (const child of children)
        if (!candidates.has(child.id)) candidates.delete(child.parentId!);
      const ids = [...candidates];
      if (!ids.length) return 0;
      const [updated] = await tx
        .update(syncState)
        .set({ version: nextVersion })
        .where(eq(syncState.userId, userId))
        .returning();
      const version = updated!.version;
      const affected = await purgeRecords(tx, userId, ids, version);
      await indexSearchRecords(tx, userId, ids, []);
      if (affected.length)
        await tx
          .update(entities)
          .set({ version, updatedAt: new Date() })
          .where(and(eq(entities.userId, userId), inArray(entities.id, affected)));
      const changed = [...new Set([...ids, ...affected])];
      await tx.insert(auditLogs).values(
        changed.map((id) => ({
          id: v7(),
          userId,
          action: 'maintenance.trashPurge',
          entityId: id,
          requestId: 'nightly-retention',
        })),
      );
      await tx.insert(outboxEvents).values({
        id: v7(),
        userId,
        type: 'entities.changed',
        payload: { entityIds: changed, version },
      });
      return ids.length;
    });
  }
  return purged;
}

/** Drop old response content, but keep hashes so offline retries cannot execute twice. */
export async function cleanupIdempotencyKeys(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT user_id, key FROM idempotency_keys k
      WHERE created_at <= ${cutoff} AND response <> '[]'::jsonb
        AND NOT EXISTS (SELECT 1 FROM deletion_requests d WHERE d.user_id = k.user_id
          AND (d.status IN ('processing', 'completed') OR d.started_at IS NOT NULL))
      ORDER BY created_at, user_id, key LIMIT 500
      FOR UPDATE SKIP LOCKED
    ) UPDATE idempotency_keys k SET response = '[]'::jsonb FROM batch b
      WHERE k.user_id = b.user_id AND k.key = b.key RETURNING k.key
  `);
  return result.rows.length;
}

/** Recompute account cached balances from transactions and alert on drift (§45.3). */
export async function reconcileBalances(
  db: Database,
): Promise<{ drifts: Array<{ accountId: string; cached: number; computed: number }> }> {
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
    .where(
      and(
        eq(exportJobs.status, 'ready'),
        or(lte(exportJobs.downloadUrlExpiresAt, new Date()), lte(exportJobs.completedAt, cutoff)),
      ),
    )
    .returning({ id: exportJobs.id });
  return result.length;
}
