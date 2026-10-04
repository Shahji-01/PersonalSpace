import type { SQLiteDatabase } from 'expo-sqlite';
import { attachmentTransferSchema, type AttachmentTransfer } from '@personalspace/validation';
import type { AttachmentTransferStore } from '@personalspace/sync';

export const attachmentTablesSql = `
  CREATE TABLE IF NOT EXISTS attachment_transfers (
    user_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT NOT NULL,
    revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id)
  );
  CREATE INDEX IF NOT EXISTS attachment_transfers_parent ON attachment_transfers(user_id,parent_id);
  CREATE TABLE IF NOT EXISTS attachment_remote_removals (
    user_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(user_id,id)
  );
  CREATE TABLE IF NOT EXISTS attachment_transfer_tombstones (
    user_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(user_id,id)
  );
  CREATE TABLE IF NOT EXISTS attachment_file_removals (
    user_id TEXT NOT NULL, id TEXT NOT NULL, local_uri TEXT NOT NULL, PRIMARY KEY(user_id,id)
  );`;

export function createAttachmentStore(
  db: SQLiteDatabase,
  userId: string,
  transaction: (work: () => Promise<void>) => Promise<void>,
  isPurged: (id: string) => Promise<boolean>,
) {
  const get = async (id: string): Promise<AttachmentTransfer | null> => {
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM attachment_transfers WHERE user_id=? AND id=?',
      userId,
      id,
    );
    return row ? attachmentTransferSchema.parse(JSON.parse(row.data)) : null;
  };
  const store: AttachmentTransferStore = {
    get,
    list: async () =>
      (
        await db.getAllAsync<{ data: string }>(
          'SELECT data FROM attachment_transfers WHERE user_id=? ORDER BY rowid',
          userId,
        )
      ).map((row) => attachmentTransferSchema.parse(JSON.parse(row.data))),
    replace: async (expectedRevision, raw) => {
      const transfer = attachmentTransferSchema.parse(raw);
      if (transfer.revision !== expectedRevision + 1) throw new Error('Invalid transfer revision');
      let changed = false;
      await transaction(async () => {
        const previous = await get(transfer.descriptor.id);
        if (!previous || previous.revision !== expectedRevision) return;
        if (
          JSON.stringify(previous.descriptor) !== JSON.stringify(transfer.descriptor) ||
          previous.localUri !== transfer.localUri ||
          previous.createdAt !== transfer.createdAt
        )
          throw new Error('Transfer identity cannot change');
        const result = await db.runAsync(
          'UPDATE attachment_transfers SET revision=?,data=? WHERE user_id=? AND id=? AND revision=?',
          transfer.revision,
          JSON.stringify(transfer),
          userId,
          transfer.descriptor.id,
          expectedRevision,
        );
        changed = Number(result.changes) === 1;
      });
      return changed;
    },
  };
  // Caller already holds the shared mobile write transaction. Keep erasure and the
  // tombstone atomic with row sync, without starting a nested SQLite transaction.
  const cancelInTransaction = async (transfers: AttachmentTransfer[]) => {
    for (const transfer of transfers) {
      const id = transfer.descriptor.id;
      await db.runAsync(
        'INSERT OR IGNORE INTO attachment_file_removals(user_id,id,local_uri) VALUES (?,?,?)',
        userId,
        id,
        transfer.localUri,
      );
      await db.runAsync(
        'INSERT OR IGNORE INTO attachment_transfer_tombstones(user_id,id) VALUES (?,?)',
        userId,
        id,
      );
      await db.runAsync('DELETE FROM attachment_transfers WHERE user_id=? AND id=?', userId, id);
    }
  };
  return {
    transfers: {
      ...store,
      enqueue: async (raw: AttachmentTransfer) => {
        const transfer = attachmentTransferSchema.parse(raw);
        if (
          transfer.state !== 'queued' ||
          transfer.revision !== 0 ||
          transfer.session ||
          transfer.parts.length ||
          transfer.failures ||
          transfer.nextAttemptAt ||
          transfer.error
        )
          throw new Error('Only a new transfer can be enqueued');
        await transaction(async () => {
          const id = transfer.descriptor.id;
          if (
            (await isPurged(transfer.descriptor.parentId)) ||
            (await isPurged(id)) ||
            (await db.getFirstAsync(
              'SELECT id FROM attachment_transfer_tombstones WHERE user_id=? AND id=?',
              userId,
              id,
            ))
          )
            throw new Error('This attachment or its parent was permanently deleted.');
          const previous = await get(id);
          if (previous) {
            if (
              JSON.stringify(previous.descriptor) !== JSON.stringify(transfer.descriptor) ||
              previous.localUri !== transfer.localUri
            )
              throw new Error('This attachment ID is already in use.');
            return; // A picker retry must never reset an existing upload's progress.
          }
          if (
            await db.getFirstAsync(
              `SELECT id FROM attachment_transfers WHERE user_id=? AND json_extract(data,'$.localUri')=?
               UNION ALL SELECT id FROM attachment_file_removals WHERE user_id=? AND local_uri=? LIMIT 1`,
              userId,
              transfer.localUri,
              userId,
              transfer.localUri,
            )
          )
            throw new Error('Each attachment needs its own durable local file.');
          await db.runAsync(
            'INSERT INTO attachment_transfers(user_id,id,parent_id,revision,data) VALUES (?,?,?,?,?)',
            userId,
            id,
            transfer.descriptor.parentId,
            transfer.revision,
            JSON.stringify(transfer),
          );
        });
      },
      resumeAfterAuthentication: () =>
        transaction(async () => {
          for (const transfer of await store.list()) {
            if (transfer.state !== 'auth_required') continue;
            const resumed: AttachmentTransfer = {
              ...transfer,
              revision: transfer.revision + 1,
              state: 'queued',
              error: null,
              nextAttemptAt: 0,
            };
            await db.runAsync(
              'UPDATE attachment_transfers SET revision=?,data=? WHERE user_id=? AND id=?',
              resumed.revision,
              JSON.stringify(resumed),
              userId,
              resumed.descriptor.id,
            );
          }
        }),
      requestRemoval: (id: string) =>
        transaction(async () => {
          const transfer = await get(id);
          if (transfer) await cancelInTransaction([transfer]);
          await db.runAsync(
            'INSERT OR IGNORE INTO attachment_transfer_tombstones(user_id,id) VALUES (?,?)',
            userId,
            id,
          );
          await db.runAsync(
            'INSERT OR IGNORE INTO attachment_remote_removals(user_id,id) VALUES (?,?)',
            userId,
            id,
          );
        }),
      pendingRemoteRemovals: () =>
        db.getAllAsync<{ id: string }>(
          'SELECT id FROM attachment_remote_removals WHERE user_id=? ORDER BY rowid',
          userId,
        ),
      removedIds: async () =>
        (
          await db.getAllAsync<{ id: string }>(
            'SELECT id FROM attachment_transfer_tombstones WHERE user_id=?',
            userId,
          )
        ).map((row) => row.id),
      acknowledgeRemoteRemoval: (id: string) =>
        transaction(async () => {
          await db.runAsync(
            'DELETE FROM attachment_remote_removals WHERE user_id=? AND id=?',
            userId,
            id,
          );
        }),
      retry: (id: string) =>
        transaction(async () => {
          const previous = await get(id);
          if (
            !previous ||
            previous.state === 'ready' ||
            previous.state === 'auth_required' ||
            ['rejected', 'local_file', 'protocol'].includes(previous.error ?? '')
          )
            return;
          const next = {
            ...previous,
            state: 'queued',
            error: null,
            nextAttemptAt: 0,
            revision: previous.revision + 1,
          };
          await db.runAsync(
            'UPDATE attachment_transfers SET revision=?,data=? WHERE user_id=? AND id=?',
            next.revision,
            JSON.stringify(next),
            userId,
            id,
          );
        }),
      cancel: (id: string) =>
        transaction(async () => {
          const transfer = await get(id);
          if (transfer) await cancelInTransaction([transfer]);
        }),
      pendingFileRemovals: () =>
        db.getAllAsync<{ id: string; localUri: string }>(
          'SELECT id,local_uri AS localUri FROM attachment_file_removals WHERE user_id=? ORDER BY rowid',
          userId,
        ),
      // Call only after the file is actually removed (or confirmed already absent).
      acknowledgeFileRemoval: (id: string) =>
        transaction(async () => {
          await db.runAsync(
            'DELETE FROM attachment_file_removals WHERE user_id=? AND id=?',
            userId,
            id,
          );
        }),
    },
    cancelForParentInTransaction: async (id: string) => {
      const rows = await db.getAllAsync<{ data: string }>(
        'SELECT data FROM attachment_transfers WHERE user_id=? AND (parent_id=? OR id=?)',
        userId,
        id,
        id,
      );
      await cancelInTransaction(
        rows.map((row) => attachmentTransferSchema.parse(JSON.parse(row.data))),
      );
    },
  };
}
