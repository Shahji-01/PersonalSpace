import { and, eq } from 'drizzle-orm';
import { attachments, outboxEvents, deletionRequests, type Database } from '@personalspace/db';
import { z } from 'zod';
import type { createS3Storage } from '@personalspace/storage';
import { cleanupEventSchema } from './attachment-cleanup';

export async function cleanAccountStorage(
  db: Database,
  storage: Pick<ReturnType<typeof createS3Storage>, 'removeAccountObjects'> | null,
  userId: string,
) {
  if (!storage) throw new Error('Account deletion requires object storage cleanup');
  // Read before database erasure: retired sessions may only remain in the
  // cleanup outbox. Both pending and acknowledged events contain useful keys.
  const files = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.userId, userId));
  const events = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.userId, userId), eq(outboxEvents.type, 'attachments.cleanup')));
  const [request] = await db
    .select({ keys: deletionRequests.storageCleanupKeys })
    .from(deletionRequests)
    .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'processing')));
  if (!request) throw new Error('Account deletion has not started');
  const keys = [
    ...new Set([
      ...z.array(z.string()).parse(request.keys),
      ...files.map((file) => file.key),
      ...events.map((event) => cleanupEventSchema.parse(event.payload).key),
    ]),
  ];
  // Retain exact multipart keys through database erasure and the delayed sweep.
  // They are cleared only when the deletion ledger is marked completed.
  await db
    .update(deletionRequests)
    .set({ storageCleanupKeys: keys })
    .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'processing')));
  await storage.removeAccountObjects(userId, keys);
}
