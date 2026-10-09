import { and, desc, eq } from 'drizzle-orm';
import { v7 } from 'uuid';
import { exportJobs, outboxEvents, withUser, type Database } from '@personalspace/db';
import type { AttachmentStorage } from '@personalspace/storage';
import { exportRequestSchema, type ExportRequest } from '@personalspace/validation';
import { DomainError } from './errors';

export function createExportAccess(db: Database, storage?: AttachmentStorage) {
  const read = (userId: string, id: string) =>
    withUser(
      db,
      userId,
      async (tx) => {
        const [job] = await tx
          .select()
          .from(exportJobs)
          .where(and(eq(exportJobs.id, id), eq(exportJobs.userId, userId)));
        if (!job) throw new DomainError('EXPORT_NOT_FOUND', 'Export not found.', 404);
        return job;
      },
      true,
    );
  const available = (job: typeof exportJobs.$inferSelect) => {
    if (job.status !== 'ready' || !job.storageKey || !job.sizeBytes)
      throw new DomainError('EXPORT_NOT_READY', 'This export is not ready to download.', 409);
    if (!job.downloadUrlExpiresAt || job.downloadUrlExpiresAt.getTime() <= Date.now())
      throw new DomainError(
        'EXPORT_EXPIRED',
        'This export has expired. Create another export.',
        410,
      );
  };
  return {
    create: (userId: string, raw: ExportRequest) => {
      const input = exportRequestSchema.parse(raw);
      return withUser(db, userId, async (tx) => {
        const [job] = await tx
          .insert(exportJobs)
          .values({ id: v7(), userId, ...input })
          .returning();
        // Commit the request and its delivery intent together. Redis outages
        // must neither lose the export nor keep the HTTP request waiting.
        await tx.insert(outboxEvents).values({
          id: job!.id,
          userId,
          type: 'exports.generate',
          payload: { jobId: job!.id, ...input },
        });
        return job!;
      });
    },
    list: (userId: string) =>
      withUser(
        db,
        userId,
        (tx) =>
          tx
            .select()
            .from(exportJobs)
            .where(eq(exportJobs.userId, userId))
            .orderBy(desc(exportJobs.createdAt))
            .limit(50),
        true,
      ),
    download: async (userId: string, id: string) => {
      const job = await read(userId, id);
      available(job);
      if (!storage)
        throw new DomainError('STORAGE_UNAVAILABLE', 'Export storage is not configured.', 503);
      const extension = job.format === 'json' ? 'json' : 'zip';
      const key = job.storageKey!;
      if (
        (!key.startsWith(`exports/${userId}/${id}/`) &&
          key !== `exports/${userId}/${id}.${extension}`) ||
        !key.endsWith(`.${extension}`)
      )
        throw new DomainError(
          'EXPORT_UNAVAILABLE',
          'Create a new export to download this format.',
          503,
        );
      const object = await storage.head(key);
      if (!object || object.size !== job.sizeBytes)
        throw new DomainError('EXPORT_UNAVAILABLE', 'This export is temporarily unavailable.', 503);
      const current = await read(userId, id);
      available(current);
      if (current.storageKey !== key)
        throw new DomainError('EXPORT_UNAVAILABLE', 'This export changed. Try again.', 409);
      const filename = `personalspace-${id}.${extension}`,
        mime = extension === 'json' ? 'application/json' : 'application/zip';
      const grant = await storage.download(key, filename, mime);
      if (Date.parse(grant.expiresAt) > current.downloadUrlExpiresAt!.getTime())
        throw new DomainError(
          'EXPORT_EXPIRED',
          'This export is expiring. Create another export.',
          410,
        );
      return { ...grant, filename, mime, size: object.size };
    },
  };
}
