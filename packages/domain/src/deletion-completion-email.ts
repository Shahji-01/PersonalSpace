import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  deletionCompletionOutbox as outbox,
  deletionRequests,
  type Database,
  type Transaction,
} from '@personalspace/db';
import { EmailDeliveryError, type EmailProvider, type EmailOutcome } from './email-provider';

// Retain version 1 unchanged while any envelope can still refer to it.
export const deletionCompletionTemplate = {
  subject: 'Your PersonalSpace account has been deleted',
  text: 'Your PersonalSpace account and its live-system data have been deleted.\n\nThis message confirms completion of your account deletion request. No action is needed.',
  html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account deletion completed</title></head><body><main><h1>Account deletion completed</h1><p>Your PersonalSpace account and its live-system data have been deleted.</p><p>This message confirms completion of your account deletion request. No action is needed.</p></main></body></html>',
} as const;

type Completion = typeof outbox.$inferSelect;
const maxAttempts = 8;
const leaseMs = 120_000;
const retryWindowMs = 23 * 60 * 60_000;

async function finish(
  tx: Transaction,
  id: string,
  status: 'accepted' | 'preview' | 'failed' | 'expired',
) {
  // Outcome and recipient erasure commit together. No provider reference or
  // recipient is copied into the permanent deletion ledger.
  await tx
    .update(deletionRequests)
    .set({ completionEmailStatus: status })
    .where(eq(deletionRequests.id, id));
  await tx.delete(outbox).where(eq(outbox.id, id));
}

export async function purgeExpiredCompletionEmails(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(sql`${outbox.expiresAt} <= clock_timestamp()`)
      .orderBy(asc(outbox.expiresAt))
      .limit(100)
      .for('update', { skipLocked: true });
    for (const row of expired) await finish(tx, row.id, 'expired');
    return expired.length;
  });
}

export async function claimCompletionEmail(
  db: Database,
  provider: EmailProvider,
): Promise<Completion | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(outbox)
      .where(
        and(
          sql`${outbox.expiresAt} > clock_timestamp()`,
          sql`exists(select 1 from deletion_requests d where d.id = ${outbox.id} and d.status = 'completed')`,
          sql`((${outbox.status} in ('pending', 'retrying') and ${outbox.nextAttemptAt} <= now())
        or (${outbox.status} = 'processing' and ${outbox.leaseExpiresAt} <= now()))`,
        ),
      )
      .orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.rows[0]!.now);
    if (
      row.attempts >= maxAttempts ||
      (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= retryWindowMs)
    ) {
      await finish(tx, row.id, 'failed');
      return null;
    }
    const [claimed] = await tx
      .update(outbox)
      .set({
        status: 'processing',
        claimId: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: row.attempts + 1,
        firstAttemptAt: sql`coalesce(${outbox.firstAttemptAt}, ${now})`,
        sender: row.firstAttemptAt ? row.sender : provider.fromAddress,
        errorCode: null,
      })
      .where(eq(outbox.id, row.id))
      .returning();
    return claimed!;
  });
}

export async function deliverCompletionEmail(
  db: Database,
  provider: EmailProvider,
  claim: Completion,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.id, claim.id),
          eq(outbox.status, 'processing'),
          eq(outbox.claimId, claim.claimId!),
          sql`${outbox.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .for('update');
    if (!row) return false;
    const [deletion] = await tx
      .select({ status: deletionRequests.status })
      .from(deletionRequests)
      .where(eq(deletionRequests.id, row.id))
      .for('share');
    if (deletion?.status !== 'completed') return false;
    const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.rows[0]!.now);
    if (row.expiresAt <= now) {
      await finish(tx, row.id, 'expired');
      return false;
    }
    if (now.getTime() - row.firstAttemptAt!.getTime() >= retryWindowMs) {
      await finish(tx, row.id, 'failed');
      return false;
    }
    let outcome: EmailOutcome | undefined;
    let failure: EmailDeliveryError | undefined;
    try {
      outcome = await provider.sendEmail({
        idempotencyKey: `personalspace/deletion-completed/${row.id}`,
        to: row.recipient,
        from: row.sender,
        ...deletionCompletionTemplate,
      });
    } catch (error) {
      failure =
        error instanceof EmailDeliveryError ? error : new EmailDeliveryError('network_error', true);
    }
    if (outcome) {
      await finish(tx, row.id, outcome.kind);
      return outcome.kind === 'accepted';
    }
    const finishedClock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const nextAttemptAt = new Date(
      new Date(finishedClock.rows[0]!.now).getTime() +
        Math.max(Math.min(3_600_000, 30_000 * 2 ** (row.attempts - 1)), failure?.retryAfterMs ?? 0),
    );
    if (
      !failure?.retryable ||
      row.attempts >= maxAttempts ||
      nextAttemptAt >= row.expiresAt ||
      nextAttemptAt.getTime() >= row.firstAttemptAt!.getTime() + retryWindowMs
    ) {
      await finish(tx, row.id, nextAttemptAt >= row.expiresAt ? 'expired' : 'failed');
      return false;
    }
    await tx
      .update(outbox)
      .set({
        status: 'retrying',
        claimId: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        errorCode: failure.code,
      })
      .where(and(eq(outbox.id, row.id), eq(outbox.claimId, row.claimId!)));
    return false;
  });
}

export async function processCompletionEmails(
  db: Database,
  provider: EmailProvider,
): Promise<number> {
  await purgeExpiredCompletionEmails(db);
  let accepted = 0;
  for (let index = 0; index < 50; index++) {
    const claimed = await claimCompletionEmail(db, provider);
    if (!claimed) break;
    if (await deliverCompletionEmail(db, provider, claimed)) accepted++;
  }
  return accepted;
}
