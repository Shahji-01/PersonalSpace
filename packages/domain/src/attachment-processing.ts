import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { attachments, entities, withUser, type Database } from '@personalspace/db';
import {
  attachmentChanged,
  attachmentVersion,
  attachmentUsage,
  lockAttachmentAccount,
  queueAttachmentCleanup,
} from './attachments';
import { DomainError } from './errors';

export type ProcessingResult =
  | { status: 'ready'; mime: string; size: number; sha256: string; thumbnailSize: number }
  | {
      status: 'rejected';
      reason: 'integrity' | 'type' | 'malware' | 'invalid_image' | 'missing' | 'quota';
    };

/** Uses a separate, owner-scoped processor role with no note/auth/money access. */
export function createAttachmentProcessor(db: Database, options: { quotaBytes?: number } = {}) {
  return {
    claim: (userId: string, id: string) =>
      withUser(db, userId, async (tx) => {
        await lockAttachmentAccount(tx, userId);
        const [row] = await tx
          .select()
          .from(attachments)
          .where(and(eq(attachments.userId, userId), eq(attachments.id, id)));
        if (!row || row.status !== 'processing') return null;
        if (row.processingLeaseUntil && row.processingLeaseUntil.getTime() > Date.now())
          throw new DomainError('PROCESSING_BUSY', 'This file is already being processed.', 409);
        // Persist output ownership before writing bytes. A replaced attempt and a
        // concurrent purge can clean up its objects, even after a process crash.
        for (const key of [row.processedKey, row.thumbnailKey])
          if (key) await queueAttachmentCleanup(tx, { userId, storageKey: key, uploadId: null });
        const [claimed] = await tx
          .update(attachments)
          .set({
            processedKey: `u/${userId}/${randomUUID()}`,
            thumbnailKey: `u/${userId}/${randomUUID()}`,
            processingToken: randomUUID(),
            processingLeaseUntil: new Date(Date.now() + 5 * 60 * 1000),
          })
          .where(and(eq(attachments.userId, userId), eq(attachments.id, id)))
          .returning();
        return claimed!;
      }),
    finish: (userId: string, id: string, token: string, result: ProcessingResult) =>
      withUser(db, userId, async (tx) => {
        await lockAttachmentAccount(tx, userId);
        const [row] = await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, userId),
              eq(attachments.id, id),
              eq(attachments.status, 'processing'),
              eq(attachments.processingToken, token),
            ),
          );
        if (!row) return false;
        if (result.status === 'ready') {
          const [usage] = await tx
            .select({ bytes: attachmentUsage })
            .from(attachments)
            .where(
              and(
                eq(attachments.userId, userId),
                ne(attachments.id, id),
                sql`${attachments.status} <> 'rejected'`,
              ),
            );
          if (
            usage!.bytes + Math.max(row.sizeBytes, result.size) + result.thumbnailSize >
            (options.quotaBytes ?? 1024 * 1024 * 1024)
          )
            result = { status: 'rejected', reason: 'quota' };
        }
        const version = await attachmentVersion(tx, userId),
          updatedAt = new Date();
        await tx
          .update(attachments)
          .set({
            status: result.status,
            version,
            updatedAt,
            processingToken: null,
            processingLeaseUntil: null,
            ...(result.status === 'ready'
              ? {
                  processedMime: result.mime,
                  processedSize: result.size,
                  processedSha256: result.sha256,
                  thumbnailKey: result.thumbnailSize ? row.thumbnailKey : null,
                  thumbnailSize: result.thumbnailSize,
                }
              : { rejectionReason: result.reason }),
          })
          .where(and(eq(attachments.userId, userId), eq(attachments.id, id)));
        await tx
          .update(entities)
          .set({ version, updatedAt })
          .where(and(eq(entities.userId, userId), eq(entities.id, id)));
        await attachmentChanged(tx, userId, id, version, `attachment.${result.status}`, token);
        if (result.status === 'rejected') await queueAttachmentCleanup(tx, row);
        else {
          await queueAttachmentCleanup(tx, {
            userId,
            storageKey: row.storageKey,
            uploadId: row.uploadId,
          });
          if (!result.thumbnailSize && row.thumbnailKey)
            await queueAttachmentCleanup(tx, {
              userId,
              storageKey: row.thumbnailKey,
              uploadId: null,
            });
        }
        return true;
      }),
    release: (userId: string, id: string, token: string) =>
      withUser(db, userId, async (tx) => {
        await tx
          .update(attachments)
          .set({ processingToken: null, processingLeaseUntil: null })
          .where(
            and(
              eq(attachments.userId, userId),
              eq(attachments.id, id),
              eq(attachments.processingToken, token),
              eq(attachments.status, 'processing'),
            ),
          );
      }),
  };
}
