/**
 * Account deletion domain service (§64.3–64.4).
 *
 * Handles the full deletion lifecycle:
 *   1. Request deletion → 14-day grace period
 *   2. Cancel deletion (during grace)
 *   3. Execute deletion pipeline (after grace expires)
 */

import { eq, and, gt, isNull, lte, or, sql } from 'drizzle-orm';
import {
  deletionRequests,
  entities,
  inboxItems,
  idempotencyKeys,
  syncState,
  recurrenceRules,
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
  authUsers,
  authAccounts,
  authSessions,
  withUser,
  type Database,
} from '@personalspace/db';
import { DomainError } from './errors';

const GRACE_DAYS = 14;

/** Request account deletion. Creates a pending request with a 14-day grace period. */
export async function requestDeletion(db: Database, userId: string, reason?: string) {
  return withUser(db, userId, async (tx) => {
    const createdAt = new Date();
    const graceEndsAt = new Date(createdAt.getTime() + GRACE_DAYS * 24 * 3600 * 1000);
    const [request] = await tx
      .insert(deletionRequests)
      .values({ userId, reason: reason ?? null, graceEndsAt, createdAt })
      .onConflictDoUpdate({
        target: deletionRequests.userId,
        set: {
          status: 'pending',
          reason: reason ?? null,
          graceEndsAt,
          createdAt,
          cancelledAt: null,
          startedAt: null,
          completedAt: null,
          step: null,
          stepsLog: [],
          storageCleanupAfter: null,
          storageCleanupKeys: [],
        },
        // A concurrent request cannot reset a grace period or overwrite a
        // running/completed deletion. Only an explicit cancellation permits retry.
        setWhere: eq(deletionRequests.status, 'cancelled'),
      })
      .returning();
    if (!request)
      throw new DomainError(
        'DELETION_ALREADY_REQUESTED',
        'A deletion request already exists.',
        409,
      );
    await tx.insert(notificationLog).values({
      userId,
      type: 'transactional',
      channel: 'email',
      dedupeKey: `deletion_request_${request.id}_${graceEndsAt.getTime()}`,
      title: 'Account deletion requested',
      body: `Your PersonalSpace account is scheduled for deletion after ${graceEndsAt.toISOString()}. Sign in and cancel before that time if you want to keep your account.`,
      status: 'pending',
    });
    return {
      id: request.id,
      status: 'pending' as const,
      graceEndsAt: request.graceEndsAt.toISOString(),
      createdAt: request.createdAt.toISOString(),
    };
  });
}

/** Cancel an active deletion request (during the grace period). */
export async function cancelDeletion(db: Database, userId: string) {
  return withUser(db, userId, async (tx) => {
    const [cancelled] = await tx
      .update(deletionRequests)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(
        and(
          eq(deletionRequests.userId, userId),
          eq(deletionRequests.status, 'pending'),
          gt(deletionRequests.graceEndsAt, new Date()),
          isNull(deletionRequests.startedAt),
        ),
      )
      .returning({ id: deletionRequests.id });
    if (!cancelled)
      throw new DomainError(
        'DELETION_NOT_CANCELLABLE',
        'There is no deletion request that can still be cancelled.',
        409,
      );
    return { status: 'cancelled' as const };
  });
}

/** Get the current deletion status for a user. */
export async function getDeletionStatus(db: Database, userId: string) {
  const existing = await withUser(
    db,
    userId,
    (tx) => tx.select().from(deletionRequests).where(eq(deletionRequests.userId, userId)),
    true,
  );
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
 * Claiming fences writes. Revoke sessions, clean storage and erase rows, then
 * repeat the storage sweep after existing upload grants have expired. Stale
 * claims are retried; the minimal deletion ledger remains after completion.
 */
export async function executePendingDeletions(
  db: Database,
  onStorageCleanup: (userId: string) => Promise<void>,
  onCacheCleanup?: (userId: string) => Promise<void>,
): Promise<string[]> {
  const claimable = and(
    lte(deletionRequests.graceEndsAt, new Date()),
    or(
      eq(deletionRequests.status, 'pending'),
      and(
        eq(deletionRequests.status, 'processing'),
        or(
          lte(deletionRequests.startedAt, new Date(Date.now() - 15 * 60000)),
          and(
            eq(deletionRequests.step, 'awaiting_storage_expiry'),
            lte(deletionRequests.storageCleanupAfter, new Date()),
          ),
        ),
      ),
    ),
  );
  const expired = await db
    .select()
    .from(deletionRequests)
    .where(claimable)
    .orderBy(deletionRequests.createdAt)
    .limit(50);

  const deleted: string[] = [];
  for (const req of expired) {
    const startedAt = new Date();
    const [claimed] = await db
      .update(deletionRequests)
      .set({
        status: 'processing',
        startedAt,
        step: 'storage',
        storageCleanupAfter: sql`coalesce(${deletionRequests.storageCleanupAfter}, ${new Date(Date.now() + 10 * 60000)})`,
      })
      .where(and(eq(deletionRequests.id, req.id), claimable))
      .returning();
    if (!claimed) continue;
    const ownsClaim = and(
      eq(deletionRequests.id, req.id),
      eq(deletionRequests.status, 'processing'),
      eq(deletionRequests.startedAt, startedAt),
    );

    const userId = req.userId;
    const logStep = async (step: string) => {
      await db
        .update(deletionRequests)
        .set({
          step,
          stepsLog: sql`${deletionRequests.stepsLog} || ${JSON.stringify([{ step, at: new Date().toISOString() }])}::jsonb`,
        })
        .where(ownsClaim);
    };

    try {
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
      await db.execute(sql`select public.erase_account_reset_tokens(${userId}::uuid)`);
      // Fail closed before deleting the database inventory. Partial object
      // cleanup is safe to repeat after outages or a stale worker restart.
      await onStorageCleanup(userId);
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

      await logStep('recurrence_rules');
      await db.delete(recurrenceRules).where(eq(recurrenceRules.userId, userId));

      await logStep('inbox_items');
      await db.delete(inboxItems).where(eq(inboxItems.userId, userId));

      await logStep('note_folders');
      await db.delete(noteFolders).where(eq(noteFolders.userId, userId));

      await logStep('projects');
      await db.delete(projects).where(eq(projects.userId, userId));

      await logStep('entities');
      await db.delete(entities).where(eq(entities.userId, userId));

      await logStep('idempotency_keys');
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));

      await logStep('sync_state');
      await db.delete(syncState).where(eq(syncState.userId, userId));

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

      // Step 2b: Erase authentication PII. Credentials and sessions are deleted
      // outright; the user row is anonymized rather than deleted so the
      // deletion_requests ledger (FK → auth_user) survives as an audit record.
      await logStep('auth_sessions');
      await db.delete(authSessions).where(eq(authSessions.userId, userId));

      await logStep('auth_accounts');
      await db.delete(authAccounts).where(eq(authAccounts.userId, userId));

      await logStep('auth_user_anonymized');
      await db
        .update(authUsers)
        .set({
          // Email is UNIQUE, so scope the tombstone to the user id to avoid collisions.
          email: `deleted+${userId}@deleted.invalid`,
          name: 'Deleted User',
          image: null,
          emailVerified: false,
          updatedAt: new Date(),
        })
        .where(eq(authUsers.id, userId));

      // Step 4: Redis/cache cleanup.
      if (onCacheCleanup) {
        await logStep('cache');
        await onCacheCleanup(userId);
      }

      // Previously signed upload URLs last five minutes. Keep the account
      // fenced, then sweep again after ten minutes before declaring erasure.
      if (claimed.storageCleanupAfter!.getTime() > Date.now()) {
        await logStep('awaiting_storage_expiry');
        continue;
      }

      // Step 5: Mark complete — the deletion_requests row itself stays as a ledger.
      const completed = await db
        .update(deletionRequests)
        .set({
          status: 'completed',
          step: 'done',
          completedAt: new Date(),
          reason: null,
          storageCleanupKeys: [],
        })
        .where(ownsClaim)
        .returning({ id: deletionRequests.id });

      if (completed.length) deleted.push(userId);
    } catch {
      // Mark as failed but keep the row so it can be retried.
      await db
        .update(deletionRequests)
        .set({
          status: 'pending', // Reset to pending for retry.
          step: 'failed',
          stepsLog: sql`${deletionRequests.stepsLog} || ${JSON.stringify([{ step: 'error', error: 'Account cleanup must be retried.', at: new Date().toISOString() }])}::jsonb`,
        })
        .where(ownsClaim);
    }
  }
  return deleted;
}
