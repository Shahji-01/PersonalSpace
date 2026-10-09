import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { exportJobs, outboxEvents, type Database } from '@personalspace/db';
import { expireExports } from '@personalspace/domain';
import type { AttachmentStorage } from '@personalspace/storage';
import { exportJobSchema } from './export-processing';

export async function relayExports(db: Database, queue: Pick<Queue, 'add'>) {
  const events = await db
    .select()
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.type, 'exports.generate')))
    .orderBy(outboxEvents.createdAt, outboxEvents.id)
    .limit(100);
  for (const event of events) {
    const payload = exportJobSchema.omit({ userId: true }).parse(event.payload);
    await queue.add(
      'generate',
      { ...payload, userId: event.userId },
      {
        jobId: payload.jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
    // Publish first. A crash before acknowledgement reuses the same queue ID.
    await db
      .update(outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(outboxEvents.id, event.id));
  }
}

/** Revoke access even without storage; retain keys until deletion succeeds. */
export async function cleanupExpiredExports(db: Database, storage: AttachmentStorage | null) {
  const expired = await expireExports(db);
  let removed = 0,
    failed = 0;
  if (!storage) return { expired, removed, failed };
  const jobs = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.status, 'expired'), isNotNull(exportJobs.storageKey)))
    .orderBy(exportJobs.completedAt, exportJobs.id)
    .limit(100);
  for (const job of jobs) {
    const key = job.storageKey!;
    // Never delete attachments or another account/job's object, even if a
    // malformed historical row points there. Include the older flat layout.
    const prefix = `exports/${job.userId}/${job.id}`;
    const suffix = key.slice(prefix.length);
    if (!key.startsWith(prefix) || !/^(?:\.[a-z]+|\/[a-zA-Z0-9-]+\.[a-z]+)$/.test(suffix)) {
      failed++;
      continue;
    }
    try {
      await storage.remove(key);
      await db
        .update(exportJobs)
        .set({ storageKey: null, sizeBytes: null })
        .where(
          and(
            eq(exportJobs.id, job.id),
            eq(exportJobs.userId, job.userId),
            eq(exportJobs.status, 'expired'),
            eq(exportJobs.storageKey, key),
          ),
        );
      removed++;
    } catch {
      // Per-object isolation lets the rest of the batch progress. Retained
      // keys are retried on the next pass, without exposing provider errors.
      failed++;
    }
  }
  return { expired, removed, failed };
}
