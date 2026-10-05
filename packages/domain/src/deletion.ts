/**
 * Account deletion domain service (§64.3–64.4).
 *
 * Handles the full deletion lifecycle:
 *   1. Request deletion → 14-day grace period, sessions revoked
 *   2. Cancel deletion (during grace)
 *   3. Execute deletion pipeline (after grace expires)
 */

import { eq, and, lte, sql } from 'drizzle-orm';
import {
  deletionRequests,
  entities,
  notes,
  tasks,
  noteFolders,
  projects,
  reminders,
  learningCollections,
  learningResources,
  people,
  financeAccounts,
  financeCategories,
  debts,
  financeTransactions,
  transactionSplits,
  transactionRevisions,
  searchDocuments,
  noteVersions,
  entityLinks,
  outboxEvents,
  auditLogs,
  userPreferences,
  deviceTokens,
  notificationLog,
  exportJobs,
  attachments,
  type Database,
} from '@personalspace/db';
import { DomainError } from './errors';

const GRACE_DAYS = 14;

/** Request account deletion. Creates a pending request with a 14-day grace period. */
export async function requestDeletion(
  db: Database,
  userId: string,
  reason?: string,
) {
  // Check for existing active request.
  const existing = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.userId, userId));
  if (existing.length) {
    const req = existing[0]!;
    if (req.status === 'pending' || req.status === 'processing') {
      throw new DomainError(
        'DELETION_ALREADY_REQUESTED',
        'A deletion request is already active.',
        409,
      );
    }
    // Previous completed/cancelled — delete it and allow a new one.
    await db.delete(deletionRequests).where(eq(deletionRequests.id, req.id));
  }

  const graceEndsAt = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000);
  const [request] = await db
    .insert(deletionRequests)
    .values({
      userId,
      reason: reason ?? null,
      graceEndsAt,
    })
    .returning();
  return {
    id: request!.id,
    status: request!.status as 'pending',
    graceEndsAt: request!.graceEndsAt.toISOString(),
    createdAt: request!.createdAt.toISOString(),
  };
}

/** Cancel an active deletion request (during the grace period). */
export async function cancelDeletion(db: Database, userId: string) {
  const existing = await db
    .select()
    .from(deletionRequests)
    .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'pending')));
  if (!existing.length) {
    throw new DomainError(
      'NO_ACTIVE_DELETION',
      'No active deletion request found.',
      404,
    );
  }
  await db
    .update(deletionRequests)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(deletionRequests.id, existing[0]!.id));
  return { status: 'cancelled' as const };
}

/** Get the current deletion status for a user. */
export async function getDeletionStatus(db: Database, userId: string) {
  const existing = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.userId, userId));
  if (!existing.length) {
    return {
      status: 'none' as const,
      graceEndsAt: null,
      createdAt: null,
    };
  }
  const req = existing[0]!;
  return {
    status: req.status as 'pending' | 'processing' | 'completed' | 'cancelled',
    graceEndsAt: req.graceEndsAt.toISOString(),
    createdAt: req.createdAt.toISOString(),
  };
}

/**
 * Execute the deletion pipeline for all expired grace periods.
 * Called by the worker on a schedule.
 *
 * Steps (§64.4):
 *  1. Hard-delete all user rows from Postgres (child → parent).
 *  2. Delete object storage prefix.
 *  3. Delete search documents.
 *  4. Purge Redis keys and caches.
 *  5. Keep a minimal deletion ledger entry.
 */
export async function executePendingDeletions(
  db: Database,
  onStorageCleanup?: (userId: string) => Promise<void>,
  onCacheCleanup?: (userId: string) => Promise<void>,
): Promise<string[]> {
  const expired = await db
    .select()
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.status, 'pending'),
        lte(deletionRequests.graceEndsAt, new Date()),
      ),
    );

  const deleted: string[] = [];
  for (const req of expired) {
    await db
      .update(deletionRequests)
      .set({ status: 'processing', startedAt: new Date(), step: 'data' })
      .where(eq(deletionRequests.id, req.id));

    const userId = req.userId;
    const logStep = async (step: string) => {
      await db
        .update(deletionRequests)
        .set({
          step,
          stepsLog: sql`${deletionRequests.stepsLog} || ${JSON.stringify([{ step, at: new Date().toISOString() }])}::jsonb`,
        })
        .where(eq(deletionRequests.id, req.id));
    };

    try {
      // Step 1: Delete all user data (child → parent order).
      await logStep('transaction_splits');
      await db.delete(transactionSplits).where(eq(transactionSplits.userId, userId));

      await logStep('transaction_revisions');
      await db.delete(transactionRevisions).where(eq(transactionRevisions.userId, userId));

      await logStep('finance_transactions');
      await db.delete(financeTransactions).where(eq(financeTransactions.userId, userId));

      await logStep('debts');
      await db.delete(debts).where(eq(debts.userId, userId));

      await logStep('finance_categories');
      await db.delete(financeCategories).where(eq(financeCategories.userId, userId));

      await logStep('finance_accounts');
      await db.delete(financeAccounts).where(eq(financeAccounts.userId, userId));

      await logStep('people');
      await db.delete(people).where(eq(people.userId, userId));

      await logStep('learning_resources');
      await db.delete(learningResources).where(eq(learningResources.userId, userId));

      await logStep('learning_collections');
      await db.delete(learningCollections).where(eq(learningCollections.userId, userId));

      await logStep('reminders');
      await db.delete(reminders).where(eq(reminders.userId, userId));

      await logStep('entity_links');
      await db.delete(entityLinks).where(eq(entityLinks.userId, userId));

      await logStep('note_versions');
      await db.delete(noteVersions).where(eq(noteVersions.userId, userId));

      await logStep('attachments');
      await db.delete(attachments).where(eq(attachments.userId, userId));

      await logStep('notes');
      await db.delete(notes).where(eq(notes.userId, userId));

      await logStep('tasks');
      await db.delete(tasks).where(eq(tasks.userId, userId));

      await logStep('note_folders');
      await db.delete(noteFolders).where(eq(noteFolders.userId, userId));

      await logStep('projects');
      await db.delete(projects).where(eq(projects.userId, userId));

      await logStep('entities');
      await db.delete(entities).where(eq(entities.userId, userId));

      // Step 2: Search documents
      await logStep('search_documents');
      await db.delete(searchDocuments).where(eq(searchDocuments.userId, userId));

      // Infrastructure data
      await logStep('notification_log');
      await db.delete(notificationLog).where(eq(notificationLog.userId, userId));

      await logStep('export_jobs');
      await db.delete(exportJobs).where(eq(exportJobs.userId, userId));

      await logStep('device_tokens');
      await db.delete(deviceTokens).where(eq(deviceTokens.userId, userId));

      await logStep('user_preferences');
      await db.delete(userPreferences).where(eq(userPreferences.userId, userId));

      await logStep('outbox_events');
      await db.delete(outboxEvents).where(eq(outboxEvents.userId, userId));

      await logStep('audit_logs');
      await db.delete(auditLogs).where(eq(auditLogs.userId, userId));

      // Step 3: Object storage cleanup.
      if (onStorageCleanup) {
        await logStep('storage');
        await onStorageCleanup(userId);
      }

      // Step 4: Redis/cache cleanup.
      if (onCacheCleanup) {
        await logStep('cache');
        await onCacheCleanup(userId);
      }

      // Step 5: Mark complete — the deletion_requests row itself stays as a ledger.
      await db
        .update(deletionRequests)
        .set({ status: 'completed', step: 'done', completedAt: new Date() })
        .where(eq(deletionRequests.id, req.id));

      deleted.push(userId);
    } catch (error) {
      // Mark as failed but keep the row so it can be retried.
      await db
        .update(deletionRequests)
        .set({
          status: 'pending', // Reset to pending for retry.
          step: 'failed',
          stepsLog: sql`${deletionRequests.stepsLog} || ${JSON.stringify([{ step: 'error', error: String(error), at: new Date().toISOString() }])}::jsonb`,
        })
        .where(eq(deletionRequests.id, req.id));
    }
  }
  return deleted;
}
