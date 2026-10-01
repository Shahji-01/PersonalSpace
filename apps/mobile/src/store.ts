import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { v7 } from 'uuid';
import { recordSchema, type Mutation, type RecordItem } from '@personalspace/validation';
import type { SyncStore } from '@personalspace/sync';
import { readDocument, type NoteDocument } from '@personalspace/editor-schema';

export type NoteDraft = { content: NoteDocument; baseVersion: number };

export const newId = () => v7({ random: Crypto.getRandomBytes(16) });
type OutboxRow = { id: string; mutation: string; previous: string | null; error: string | null };
let writes: Promise<void> = Promise.resolve();
export async function openStore(userId: string) {
  const db = await SQLite.openDatabaseAsync('personalspace.db');
  const transaction = (work: () => Promise<void>) => {
    const result = writes.then(() => db.withTransactionAsync(work));
    writes = result.catch(() => {});
    return result;
  };
  await db.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS outbox (user_id TEXT NOT NULL, id TEXT NOT NULL, mutation TEXT NOT NULL, previous TEXT, error TEXT, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS cursors (user_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS note_drafts (user_id TEXT NOT NULL, note_id TEXT NOT NULL, content TEXT NOT NULL, base_version INTEGER NOT NULL, PRIMARY KEY(user_id,note_id));`);
  const save = async (item: RecordItem) => {
    await db.runAsync(
      'INSERT OR REPLACE INTO records(user_id,id,data) VALUES (?,?,?)',
      userId,
      item.id,
      JSON.stringify(item),
    );
  };
  const pending = async () =>
    (
      await db.getAllAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE user_id=? AND error IS NULL ORDER BY rowid',
        userId,
      )
    ).map((r) => JSON.parse(r.mutation) as Mutation);
  const store: SyncStore = {
    pending,
    acknowledge: async (id, records) => {
      await transaction(async () => {
        const queued = await db.getFirstAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE user_id=? AND id=?',
          userId,
          id,
        );
        const command = queued ? (JSON.parse(queued.mutation) as Mutation).command : null;
        for (const item of records) await save(item);
        if (command?.op === 'note.updateContent') {
          // Only discard the exact draft acknowledged by the server, never a newer edit.
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=? AND content=? AND base_version=?',
            userId,
            command.id,
            JSON.stringify(command.contentJson),
            command.baseVersion,
          );
        }
        if (command?.op === 'note.purge')
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=?',
            userId,
            command.id,
          );
        await db.runAsync('DELETE FROM outbox WHERE user_id=? AND id=?', userId, id);
      });
    },
    reject: async (id, message) => {
      await transaction(async () => {
        const row = await db.getFirstAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE user_id=? AND id=?',
          userId,
          id,
        );
        if (row?.previous) await save(recordSchema.parse(JSON.parse(row.previous)));
        await db.runAsync(
          'UPDATE outbox SET error=? WHERE user_id=? AND id=?',
          message,
          userId,
          id,
        );
        // A pull may have skipped this row while it was optimistic. Fetch the full
        // current snapshot after rejection instead of leaving the rollback stale.
        await db.runAsync('INSERT OR REPLACE INTO cursors(user_id,cursor) VALUES (?,0)', userId);
      });
    },
    cursor: async () =>
      (
        await db.getFirstAsync<{ cursor: number }>(
          'SELECT cursor FROM cursors WHERE user_id=?',
          userId,
        )
      )?.cursor ?? 0,
    merge: async (records, cursor) => {
      await transaction(async () => {
        const queued = await pending();
        const protectedIds = new Set(
          queued.map((m) => (m.command.op === 'capture' ? m.command.payload.id : m.command.id)),
        );
        for (const item of records) if (!protectedIds.has(item.id)) await save(item);
        await db.runAsync(
          'INSERT OR REPLACE INTO cursors(user_id,cursor) VALUES (?,?)',
          userId,
          cursor,
        );
      });
    },
  };
  return {
    ...store,
    loadDraft: async (noteId: string): Promise<NoteDraft | null> => {
      const row = await db.getFirstAsync<{ content: string; base_version: number }>(
        'SELECT content,base_version FROM note_drafts WHERE user_id=? AND note_id=?',
        userId,
        noteId,
      );
      return row
        ? { content: readDocument(JSON.parse(row.content)), baseVersion: row.base_version }
        : null;
    },
    saveDraft: async (noteId: string, draft: NoteDraft) => {
      const content = readDocument(draft.content);
      await transaction(async () => {
        await db.runAsync(
          'INSERT OR REPLACE INTO note_drafts(user_id,note_id,content,base_version) VALUES (?,?,?,?)',
          userId,
          noteId,
          JSON.stringify(content),
          draft.baseVersion,
        );
      });
    },
    discardDraft: async (noteId: string) => {
      await transaction(async () => {
        await db.runAsync('DELETE FROM note_drafts WHERE user_id=? AND note_id=?', userId, noteId);
      });
    },
    list: async () =>
      (
        await db.getAllAsync<{ data: string }>(
          'SELECT data FROM records WHERE user_id=? ORDER BY id DESC',
          userId,
        )
      ).map((r) => recordSchema.parse(JSON.parse(r.data))),
    problems: async () =>
      db.getAllAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE user_id=? AND error IS NOT NULL',
        userId,
      ),
    dismissProblem: async (id: string) => {
      await transaction(async () => {
        const row = await db.getFirstAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE user_id=? AND id=? AND error IS NOT NULL',
          userId,
          id,
        );
        if (row && !row.previous) {
          const mutation = JSON.parse(row.mutation) as Mutation;
          if (mutation.command.op === 'capture')
            await db.runAsync(
              'DELETE FROM records WHERE user_id=? AND id=?',
              userId,
              mutation.command.payload.id,
            );
        }
        await db.runAsync(
          'DELETE FROM outbox WHERE user_id=? AND id=? AND error IS NOT NULL',
          userId,
          id,
        );
      });
    },
    enqueue: async (
      mutation: Mutation,
      optimistic?: RecordItem,
      previous?: RecordItem,
      removeId?: string,
    ) => {
      await transaction(async () => {
        // Purge removes the record locally right away; `previous` restores it if the server
        // rejects the change (for example a version conflict) via the reject handler above.
        if (removeId)
          await db.runAsync('DELETE FROM records WHERE user_id=? AND id=?', userId, removeId);
        if (optimistic) await save(optimistic);
        await db.runAsync(
          'INSERT INTO outbox(user_id,id,mutation,previous) VALUES (?,?,?,?)',
          userId,
          mutation.mutationId,
          JSON.stringify(mutation),
          previous ? JSON.stringify(previous) : null,
        );
      });
    },
    close: () => db.closeAsync(),
  };
}
export type LocalStore = Awaited<ReturnType<typeof openStore>>;
