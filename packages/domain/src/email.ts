import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { deletionRequests, notificationLog, type Database } from '@personalspace/db';
import { EmailDeliveryError, type EmailProvider, type EmailOutcome } from './email-provider';

export * from './email-provider';

const leaseMs = 120_000;
const maxAttempts = 8;
// Resend retains keys for 24 hours. Stop earlier, including after a long outage.
const retryWindowMs = 23 * 60 * 60 * 1000;
type Email = typeof notificationLog.$inferSelect;
type Claim = { kind: 'claimed'; email: Email } | { kind: 'skipped' };

const accountIsErasing = sql`exists (
  select 1 from deletion_requests d where d.user_id = ${notificationLog.userId}
  and (d.status in ('processing', 'completed') or (d.status = 'pending' and d.started_at is not null))
)`;

/** Claim one envelope at a time so queued messages cannot outlive a batch lease. */
export async function claimNextEmail(db: Database, provider: EmailProvider): Promise<Claim | null> {
  return db.transaction(async (tx) => {
    const [email] = await tx
      .select()
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.channel, 'email'),
          sql`not ${accountIsErasing}`,
          sql`((${notificationLog.status} in ('pending', 'retrying') and ${notificationLog.emailNextAttemptAt} <= now())
          or (${notificationLog.status} = 'processing' and ${notificationLog.emailLeaseExpiresAt} <= now()))`,
        ),
      )
      .orderBy(
        asc(notificationLog.emailNextAttemptAt),
        asc(notificationLog.createdAt),
        asc(notificationLog.id),
      )
      .limit(1)
      .for('update', { skipLocked: true });
    if (!email) return null;
    const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.rows[0]!.now);
    const failure = !email.emailTo
      ? 'recipient_missing'
      : email.emailExpiresAt && email.emailExpiresAt <= now
        ? 'expired'
        : email.emailFirstAttemptAt &&
            now.getTime() - email.emailFirstAttemptAt.getTime() >= retryWindowMs
          ? 'delivery_uncertain'
          : email.emailAttempts >= maxAttempts
            ? 'attempts_exhausted'
            : null;
    if (failure) {
      await tx
        .update(notificationLog)
        .set({
          status: 'failed',
          emailErrorCode: failure,
          error: null,
          emailClaimId: null,
          emailLeaseExpiresAt: null,
        })
        .where(eq(notificationLog.id, email.id));
      return { kind: 'skipped' };
    }
    const [claimed] = await tx
      .update(notificationLog)
      .set({
        status: 'processing',
        emailClaimId: randomUUID(),
        emailLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        emailAttempts: email.emailAttempts + 1,
        // Preserve PostgreSQL sub-millisecond precision on recovered rows.
        emailFirstAttemptAt: sql`coalesce(${notificationLog.emailFirstAttemptAt}, ${now})`,
        emailFrom: email.emailFirstAttemptAt ? email.emailFrom : provider.fromAddress,
        emailErrorCode: null,
        error: null,
      })
      .where(eq(notificationLog.id, email.id))
      .returning();
    return { kind: 'claimed', email: claimed! };
  });
}

/** Stale workers cannot submit or finalize a newer worker's lease. */
export async function deliverClaimedEmail(
  db: Database,
  provider: EmailProvider,
  claim: Email,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Match the erasure trigger's lock: deletion cannot start during bounded I/O.
    const [deletion] = await tx
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.userId, claim.userId))
      .for('share');
    if (
      deletion &&
      (['processing', 'completed'].includes(deletion.status) ||
        (deletion.status === 'pending' && deletion.startedAt))
    )
      return false;
    const ownsClaim = and(
      eq(notificationLog.id, claim.id),
      eq(notificationLog.status, 'processing'),
      eq(notificationLog.emailClaimId, claim.emailClaimId!),
      sql`${notificationLog.emailLeaseExpiresAt} > clock_timestamp()`,
    );
    const [email] = await tx.select().from(notificationLog).where(ownsClaim).for('update');
    if (!email) return false;
    const clock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.rows[0]!.now);
    let outcome: EmailOutcome | undefined;
    let failure: EmailDeliveryError | undefined;
    if (email.emailExpiresAt && email.emailExpiresAt <= now) {
      failure = new EmailDeliveryError('expired', false);
    } else if (now.getTime() - email.emailFirstAttemptAt!.getTime() >= retryWindowMs) {
      failure = new EmailDeliveryError('delivery_uncertain', false);
    } else {
      try {
        outcome = await provider.sendEmail({
          idempotencyKey: `personalspace/email/${email.id}`,
          to: email.emailTo!,
          from: email.emailFrom,
          subject: email.title,
          text: email.body ?? '',
          html: email.emailHtml,
        });
      } catch (error) {
        failure =
          error instanceof EmailDeliveryError
            ? error
            : new EmailDeliveryError('network_error', true);
      }
    }
    // Honor Retry-After only inside the idempotency window and message expiry.
    const backoff = Math.min(60 * 60_000, 30_000 * 2 ** (email.emailAttempts - 1));
    const finishedClock = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    const finishedAt = new Date(finishedClock.rows[0]!.now);
    const nextAttempt = new Date(
      finishedAt.getTime() + Math.max(backoff, failure?.retryAfterMs ?? 0),
    );
    const withinWindow =
      nextAttempt.getTime() < email.emailFirstAttemptAt!.getTime() + retryWindowMs;
    const withinExpiry = !email.emailExpiresAt || nextAttempt < email.emailExpiresAt;
    const retry =
      failure?.retryable && email.emailAttempts < maxAttempts && withinWindow && withinExpiry;
    const errorCode = failure
      ? !withinWindow
        ? 'delivery_uncertain'
        : !withinExpiry
          ? 'expired'
          : failure.retryable && email.emailAttempts >= maxAttempts
            ? 'attempts_exhausted'
            : failure.code
      : null;
    await tx
      .update(notificationLog)
      .set({
        status: outcome?.kind ?? (retry ? 'retrying' : 'failed'),
        emailProviderId: outcome?.kind === 'accepted' ? outcome.providerId : null,
        emailAcceptedAt: outcome?.kind === 'accepted' ? finishedAt : null,
        emailErrorCode: errorCode,
        emailNextAttemptAt: nextAttempt,
        emailClaimId: null,
        emailLeaseExpiresAt: null,
        error: null,
      })
      .where(
        and(
          eq(notificationLog.id, email.id),
          eq(notificationLog.emailClaimId, email.emailClaimId!),
        ),
      );
    return outcome?.kind === 'accepted';
  });
}

/** Returns provider acceptances, never preview counts or assumed deliveries. */
export async function processPendingEmails(db: Database, provider: EmailProvider): Promise<number> {
  let accepted = 0;
  for (let index = 0; index < 50; index++) {
    const claim = await claimNextEmail(db, provider);
    if (!claim) break;
    if (claim.kind === 'claimed' && (await deliverClaimedEmail(db, provider, claim.email)))
      accepted++;
  }
  return accepted;
}
