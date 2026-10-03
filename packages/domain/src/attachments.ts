import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  attachments,
  notes,
  entities,
  syncState,
  auditLogs,
  outboxEvents,
  withUser,
  type Database,
  type Transaction,
} from '@personalspace/db';
import {
  attachmentDescriptorSchema,
  attachmentLimits,
  attachmentUploadStateSchema,
  type AttachmentDescriptor,
  type AttachmentUploadState,
  type UploadedPart,
} from '@personalspace/validation';
import type { AttachmentStorage } from '@personalspace/storage';
import { nextVersion, scrubRetryRecords } from './capture.repository';
import { DomainError } from './errors';

type Attachment = typeof attachments.$inferSelect;
const partSize = attachmentLimits.multipartAboveBytes;
async function lock(tx: Transaction, userId: string) {
  await tx.insert(syncState).values({ userId }).onConflictDoNothing();
  await tx.select().from(syncState).where(eq(syncState.userId, userId)).for('update');
}
async function versionFor(tx: Transaction, userId: string) {
  const [state] = await tx
    .update(syncState)
    .set({ version: nextVersion })
    .where(eq(syncState.userId, userId))
    .returning();
  return state!.version;
}
async function changed(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  action: string,
  requestId: string,
) {
  await tx.insert(auditLogs).values({ id: v7(), userId, entityId: id, action, requestId });
  await tx
    .insert(outboxEvents)
    .values({ id: v7(), userId, type: 'entities.changed', payload: { entityIds: [id], version } });
}
async function owned(tx: Transaction, userId: string, id: string) {
  const [found] = await tx
    .select({ row: attachments })
    .from(attachments)
    .innerJoin(
      notes,
      and(eq(notes.id, attachments.parentId), eq(notes.userId, userId), isNull(notes.deletedAt)),
    )
    .where(
      and(eq(attachments.id, id), eq(attachments.userId, userId), isNull(attachments.deletedAt)),
    );
  if (!found) throw new DomainError('ATTACHMENT_NOT_FOUND', 'This attachment is unavailable.', 404);
  return found.row;
}
const descriptorFor = (row: Attachment) =>
  attachmentDescriptorSchema.parse({
    id: row.id,
    parentId: row.parentId,
    filename: row.filename,
    size: row.sizeBytes,
    mime: row.declaredMime,
    sha256: row.sha256,
  });
const terminal = (row: Attachment): AttachmentUploadState =>
  attachmentUploadStateSchema.parse({ status: row.status });

export async function queueAttachmentCleanup(
  tx: Transaction,
  row: Pick<Attachment, 'userId' | 'storageKey' | 'uploadId'>,
) {
  await tx.insert(outboxEvents).values({
    id: v7(),
    userId: row.userId,
    type: 'attachments.cleanup',
    payload: {
      key: row.storageKey,
      uploadId: row.uploadId,
      notBefore: Date.now() + 10 * 60 * 1000,
    },
  });
}

/** Called inside the parent's mutation, before its metadata is deleted. */
export async function purgeParentAttachments(tx: Transaction, userId: string, parentIds: string[]) {
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.userId, userId),
        or(inArray(attachments.parentId, parentIds), inArray(attachments.id, parentIds)),
      ),
    );
  for (const row of rows) await queueAttachmentCleanup(tx, row);
  if (rows.length)
    await tx.delete(attachments).where(
      and(
        eq(attachments.userId, userId),
        inArray(
          attachments.id,
          rows.map((row) => row.id),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

export async function trashParentAttachments(
  tx: Transaction,
  userId: string,
  parentId: string,
  version: number,
  deletedAt: Date | null,
  restoreFrom?: Date,
) {
  const rows = await tx
    .update(attachments)
    .set({ deletedAt, updatedAt: new Date(), version })
    .where(
      and(
        eq(attachments.userId, userId),
        eq(attachments.parentId, parentId),
        restoreFrom ? eq(attachments.deletedAt, restoreFrom) : isNull(attachments.deletedAt),
      ),
    )
    .returning({ id: attachments.id });
  return rows.map((row) => row.id);
}

export function createAttachmentService(
  db: Database,
  storage: AttachmentStorage,
  options: { quotaBytes?: number; uploadsPerHour?: number } = {},
) {
  const read = (userId: string, id: string) =>
    withUser(db, userId, (tx) => owned(tx, userId, id), true);
  async function register(userId: string, raw: AttachmentDescriptor, requestId: string) {
    const descriptor = attachmentDescriptorSchema.parse(raw);
    return withUser(db, userId, async (tx) => {
      await lock(tx, userId);
      const [existing] = await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.userId, userId), eq(attachments.id, descriptor.id)));
      if (existing) {
        const row = await owned(tx, userId, descriptor.id);
        if (JSON.stringify(descriptorFor(row)) !== JSON.stringify(descriptor))
          throw new DomainError(
            'ATTACHMENT_ID_REUSED',
            'This attachment ID is already used by a different file.',
            409,
          );
        return row;
      }
      const [parent] = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(eq(notes.id, descriptor.parentId), eq(notes.userId, userId), isNull(notes.deletedAt)),
        );
      if (!parent)
        throw new DomainError(
          'NOTE_NOT_FOUND',
          'Sync or restore the note before uploading its attachments.',
          404,
        );
      const [usage] = await tx
        .select({ bytes: sql<number>`coalesce(sum(${attachments.sizeBytes}),0)`.mapWith(Number) })
        .from(attachments)
        .where(and(eq(attachments.userId, userId), sql`${attachments.status} <> 'rejected'`));
      if (usage!.bytes + descriptor.size > (options.quotaBytes ?? 1024 * 1024 * 1024))
        throw new DomainError(
          'STORAGE_QUOTA_EXCEEDED',
          'Your attachment storage limit has been reached.',
          422,
        );
      const [rate] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.userId, userId),
            eq(auditLogs.action, 'attachment.register'),
            sql`${auditLogs.createdAt} > now() - interval '1 hour'`,
          ),
        );
      if (rate!.count >= (options.uploadsPerHour ?? 60))
        throw new DomainError('UPLOAD_RATE_LIMITED', 'Try uploading more files in an hour.', 429);
      const version = await versionFor(tx, userId);
      const inserted = await tx
        .insert(entities)
        .values({ id: descriptor.id, userId, type: 'attachment', version })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length)
        throw new DomainError('ID_UNAVAILABLE', 'This attachment ID is unavailable.', 409);
      const [row] = await tx
        .insert(attachments)
        .values({
          id: descriptor.id,
          userId,
          parentId: descriptor.parentId,
          filename: descriptor.filename,
          declaredMime: descriptor.mime,
          sizeBytes: descriptor.size,
          sha256: descriptor.sha256,
          version,
          storageKey: `u/${userId}/${randomUUID()}`,
        })
        .returning();
      await changed(tx, userId, descriptor.id, version, 'attachment.register', requestId);
      return row!;
    });
  }
  async function finish(userId: string, row: Attachment, size: number, requestId: string) {
    return withUser(db, userId, async (tx) => {
      await lock(tx, userId);
      const current = await owned(tx, userId, row.id);
      if (current.status !== 'pending') return terminal(current);
      if (current.sessionId !== row.sessionId)
        throw new DomainError(
          'UPLOAD_SESSION_CHANGED',
          'Resume this upload before completing it.',
          409,
        );
      const status = size === current.sizeBytes ? 'processing' : 'rejected';
      const version = await versionFor(tx, userId);
      const updatedAt = new Date();
      await tx
        .update(attachments)
        .set({ status, version, updatedAt })
        .where(eq(attachments.id, row.id));
      await tx
        .update(entities)
        .set({ version, updatedAt })
        .where(and(eq(entities.id, row.id), eq(entities.userId, userId)));
      await changed(tx, userId, row.id, version, `attachment.${status}`, requestId);
      if (status === 'rejected') await queueAttachmentCleanup(tx, current);
      else
        await tx.insert(outboxEvents).values({
          id: v7(),
          userId,
          type: 'attachments.process',
          payload: { attachmentId: row.id },
        });
      return { status } as const;
    });
  }
  async function reconcile(
    userId: string,
    row: Attachment,
    requestId: string,
  ): Promise<AttachmentUploadState> {
    if (row.status !== 'pending') return terminal(row);
    const object = await storage.head(row.storageKey);
    if (object) return finish(userId, row, object.size, requestId);
    if (row.sizeBytes <= partSize)
      return { status: 'uploading', session: { id: row.sessionId, partSize }, parts: [] };
    let parts = row.uploadId ? await storage.parts(row.storageKey, row.uploadId) : null;
    if (parts === null) {
      const uploadId = await storage.createMultipart(row.storageKey);
      let selected: Attachment;
      try {
        selected = await withUser(db, userId, async (tx) => {
          await lock(tx, userId);
          const current = await owned(tx, userId, row.id);
          if (
            current.status !== 'pending' ||
            current.uploadId !== row.uploadId ||
            current.sessionId !== row.sessionId
          )
            return current;
          const [updated] = await tx
            .update(attachments)
            .set({ uploadId, sessionId: randomUUID() })
            .where(and(eq(attachments.userId, userId), eq(attachments.id, row.id)))
            .returning();
          return updated!;
        });
      } catch (error) {
        await storage.abort(row.storageKey, uploadId);
        throw error;
      }
      if (selected.uploadId !== uploadId) await storage.abort(row.storageKey, uploadId);
      row = selected;
      if (row.status !== 'pending') return terminal(row);
      parts = await storage.parts(row.storageKey, row.uploadId!);
      if (!parts) throw new DomainError('UPLOAD_SESSION_CHANGED', 'Resume this upload again.', 409);
    }
    const count = Math.ceil(row.sizeBytes / partSize);
    if (
      new Set(parts.map((part) => part.number)).size !== parts.length ||
      parts.some(
        (part) =>
          part.number < 1 ||
          part.number > count ||
          part.size !== Math.min(partSize, row.sizeBytes - (part.number - 1) * partSize),
      )
    )
      throw new DomainError(
        'INVALID_UPLOAD_PARTS',
        'The uploaded parts have unexpected sizes. Cancel this upload and choose the file again.',
        422,
      );
    // Recheck ownership/lifecycle after storage I/O; do not hold the row-sync lock over a network request.
    const current = await read(userId, row.id);
    if (current.status !== 'pending') return terminal(current);
    if (current.sessionId !== row.sessionId)
      throw new DomainError('UPLOAD_SESSION_CHANGED', 'Resume this upload again.', 409);
    return {
      status: 'uploading',
      session: { id: row.sessionId, partSize },
      parts: parts.map(({ number, etag }) => ({ number, etag })),
    };
  }
  return {
    open: async (userId: string, descriptor: AttachmentDescriptor, requestId: string) =>
      reconcile(userId, await register(userId, descriptor, requestId), requestId),
    part: async (userId: string, id: string, sessionId: string, number: number) => {
      const row = await read(userId, id);
      if (
        row.status !== 'pending' ||
        row.sessionId !== sessionId ||
        (row.sizeBytes > partSize && !row.uploadId)
      )
        throw new DomainError(
          'UPLOAD_SESSION_CHANGED',
          'Resume this upload before sending another part.',
          409,
        );
      const size = Math.min(partSize, row.sizeBytes - (number - 1) * partSize);
      if (!Number.isInteger(number) || number < 1 || size <= 0)
        throw new DomainError('INVALID_UPLOAD_PART', 'This upload part is out of range.', 422);
      return storage.grant({
        key: row.storageKey,
        uploadId: row.uploadId,
        number,
        size,
        sha256: row.sha256,
      });
    },
    complete: async (
      userId: string,
      id: string,
      sessionId: string,
      submitted: UploadedPart[],
      requestId: string,
    ): Promise<AttachmentUploadState> => {
      const row = await read(userId, id);
      if (row.status !== 'pending') return terminal(row);
      if (row.sessionId !== sessionId)
        throw new DomainError(
          'UPLOAD_SESSION_CHANGED',
          'Resume this upload before completing it.',
          409,
        );
      const object = await storage.head(row.storageKey);
      if (object) return finish(userId, row, object.size, requestId);
      if (!row.uploadId)
        throw new DomainError('UPLOAD_INCOMPLETE', 'Upload the file before completing it.', 409);
      const actual = await storage.parts(row.storageKey, row.uploadId);
      const count = Math.ceil(row.sizeBytes / partSize);
      const sorted = [...submitted].sort((a, b) => a.number - b.number);
      if (
        !actual ||
        sorted.length !== count ||
        actual.length !== count ||
        sorted.some(
          (part, index) =>
            part.number !== index + 1 ||
            !actual.some(
              (value) =>
                value.number === part.number &&
                value.etag === part.etag &&
                value.size === Math.min(partSize, row.sizeBytes - index * partSize),
            ),
        )
      )
        throw new DomainError(
          'UPLOAD_INCOMPLETE',
          'Resume the upload to check its completed parts.',
          409,
        );
      try {
        await storage.complete(row.storageKey, row.uploadId, sorted);
      } catch (error) {
        if (!(await storage.head(row.storageKey))) throw error;
      }
      const finished = await storage.head(row.storageKey);
      if (!finished)
        throw new DomainError('UPLOAD_INCOMPLETE', 'The uploaded file is not available yet.', 409);
      return finish(userId, row, finished.size, requestId);
    },
    cancel: async (userId: string, id: string, requestId: string) =>
      withUser(db, userId, async (tx) => {
        await lock(tx, userId);
        const [marker] = await tx
          .select()
          .from(entities)
          .where(
            and(eq(entities.id, id), eq(entities.userId, userId), eq(entities.type, 'attachment')),
          );
        if (marker?.purgedAt) return { cancelled: true };
        const row = await owned(tx, userId, id);
        if (row.status === 'ready')
          throw new DomainError(
            'ATTACHMENT_READY',
            'Remove this attachment from its note instead.',
            409,
          );
        const version = await versionFor(tx, userId);
        await queueAttachmentCleanup(tx, row);
        await tx
          .delete(attachments)
          .where(and(eq(attachments.userId, userId), eq(attachments.id, id)));
        const now = new Date();
        await tx
          .update(entities)
          .set({ purgedAt: now, deletedAt: now, updatedAt: now, version })
          .where(and(eq(entities.userId, userId), eq(entities.id, id)));
        await changed(tx, userId, id, version, 'attachment.cancel', requestId);
        await scrubRetryRecords(tx, userId, [id]);
        return { cancelled: true };
      }),
  };
}
