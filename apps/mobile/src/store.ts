import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { v7 } from 'uuid';
import {
  noteVersionSchema,
  recordSchema,
  type Mutation,
  type RecordItem,
  type NoteVersion,
  type SearchQuery,
  type SearchResponse,
  taskEditOperations,
} from '@personalspace/validation';
import type { SyncStore } from '@personalspace/sync';
import { readDocument, type NoteDocument } from '@personalspace/editor-schema';
import { searchIndexSql, searchLocal } from './search-index';
import { attachmentTablesSql, createAttachmentStore } from './attachment-store';
import { attachmentCacheTablesSql, createAttachmentCacheStore } from './attachment-cache-store';

export type NoteDraft = { content: NoteDocument; baseVersion: number };

// Account-scoped cache schema as an ordered, versioned migration list tracked by
// SQLite's PRAGMA user_version. Append new migrations; never edit an applied one.
// v1 is written with IF NOT EXISTS so databases created before versioning (which
// sit at user_version 0 with these tables already present) adopt it harmlessly.
export const CACHE_MIGRATIONS: string[] = [
  // v1 — records, outbox, sync cursors/recovery, drafts, tombstones, note history,
  // attachment transfer/cache tables and the FTS search index.
  `CREATE TABLE IF NOT EXISTS records (user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
   CREATE TABLE IF NOT EXISTS outbox (user_id TEXT NOT NULL, id TEXT NOT NULL, mutation TEXT NOT NULL, previous TEXT, error TEXT, PRIMARY KEY(user_id,id));
   CREATE TABLE IF NOT EXISTS cursors (user_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS sync_recovery (user_id TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS note_drafts (user_id TEXT NOT NULL, note_id TEXT NOT NULL, content TEXT NOT NULL, base_version INTEGER NOT NULL, PRIMARY KEY(user_id,note_id));
   CREATE TABLE IF NOT EXISTS tombstones (user_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(user_id,id));
   CREATE TABLE IF NOT EXISTS note_history (user_id TEXT NOT NULL, note_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
   CREATE INDEX IF NOT EXISTS note_history_by_note ON note_history(user_id,note_id,version DESC);
   ${attachmentTablesSql}
   ${attachmentCacheTablesSql}
   ${searchIndexSql}`,
];

/** Apply pending cache migrations, advancing PRAGMA user_version one step at a time. */
export async function migrateCache(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  for (; version < CACHE_MIGRATIONS.length; version++) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(CACHE_MIGRATIONS[version]!);
      // user_version only accepts a literal; the value is our own array index.
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return version;
}

export const newId = () => v7({ random: Crypto.getRandomBytes(16) });
type OutboxRow = { id: string; mutation: string; previous: string | null; error: string | null };
let writes: Promise<void> = Promise.resolve();
export async function openStore(
  userId: string,
  chooseTaskScope?: (record: RecordItem) => Promise<'occurrence' | 'future' | null>,
) {
  const db = await SQLite.openDatabaseAsync('personalspace.db');
  const transaction = (work: () => Promise<void>) => {
    const result = writes.then(() => db.withTransactionAsync(work));
    writes = result.catch(() => {});
    return result;
  };
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await migrateCache(db);
  await transaction(async () => {
    if (!(await db.getFirstAsync('SELECT version FROM search_index_meta WHERE version = 1'))) {
      // Populate existing caches once through the same trigger used by later writes.
      await db.execAsync(
        'UPDATE records SET data = data; INSERT INTO search_index_meta(version) VALUES (1);',
      );
    }
  });
  const isPurged = async (id: string) =>
    !!(await db.getFirstAsync('SELECT id FROM tombstones WHERE user_id=? AND id=?', userId, id));
  const attachmentStore = createAttachmentStore(db, userId, transaction, isPurged);
  const save = async (item: RecordItem) => {
    if (await isPurged(item.id)) return;
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
  const targetId = (m: Mutation) =>
    m.command.op === 'capture' ? m.command.payload.id : m.command.id;
  const contentPending = async () =>
    (await pending()).filter((m) => m.command.op !== 'note.checkpoint');
  const saveRemote = async (item: RecordItem) => {
    const cached = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM records WHERE user_id=? AND id=?',
      userId,
      item.id,
    );
    if (!cached || recordSchema.parse(JSON.parse(cached.data)).version <= item.version)
      await save(item);
  };
  const store: SyncStore = {
    pending,
    recovering: async () =>
      !!(await db.getFirstAsync('SELECT user_id FROM sync_recovery WHERE user_id=?', userId)),
    beginRecovery: async () => {
      await transaction(async () => {
        await db.runAsync('INSERT OR IGNORE INTO sync_recovery(user_id) VALUES (?)', userId);
        await db.runAsync('INSERT OR REPLACE INTO cursors(user_id,cursor) VALUES (?,0)', userId);
      });
    },
    finishRecovery: async () => {
      await transaction(async () => {
        await db.runAsync('DELETE FROM sync_recovery WHERE user_id=?', userId);
      });
    },
    acknowledge: async (id, records) => {
      await transaction(async () => {
        const queued = await db.getFirstAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE user_id=? AND id=?',
          userId,
          id,
        );
        const command = queued ? (JSON.parse(queued.mutation) as Mutation).command : null;
        const protectedIds = new Set(
          (await contentPending()).filter((m) => m.mutationId !== id).map(targetId),
        );
        for (const item of records) if (!protectedIds.has(item.id)) await saveRemote(item);
        if (command?.op === 'note.openDaily' && records.every((r) => r.id !== command.id)) {
          // Daily placeholders cannot be edited until acknowledged. A different device
          // may already own the date; replace the empty placeholder with its note.
          // An empty replay means that note was subsequently purged.
          await db.runAsync('DELETE FROM records WHERE user_id=? AND id=?', userId, command.id);
        }
        if (command?.op === 'note.updateContent' || command?.op === 'task.updateDescription') {
          // Only discard the exact draft acknowledged by the server, never a newer edit.
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=? AND content=? AND base_version=?',
            userId,
            command.id,
            JSON.stringify(command.contentJson),
            command.baseVersion,
          );
        }
        if (command?.op === 'note.copyDraft' && records.some((r) => r.id === command.id)) {
          // A copy is durable before the exact source draft/failed save is retired.
          // Newer edits on the original remain untouched.
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=? AND content=? AND base_version=?',
            userId,
            command.sourceId,
            JSON.stringify(command.contentJson),
            command.sourceBaseVersion,
          );
          const failed = await db.getAllAsync<OutboxRow>(
            'SELECT * FROM outbox WHERE user_id=? AND error IS NOT NULL',
            userId,
          );
          for (const row of failed) {
            const change = (JSON.parse(row.mutation) as Mutation).command;
            if (
              (change.op === 'note.updateContent' || change.op === 'note.checkpoint') &&
              change.id === command.sourceId &&
              change.baseVersion === command.sourceBaseVersion &&
              JSON.stringify(change.contentJson) === JSON.stringify(command.contentJson)
            )
              await db.runAsync('DELETE FROM outbox WHERE user_id=? AND id=?', userId, row.id);
          }
        }
        if (command?.op === 'note.purge' || command?.op === 'task.purge') {
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=?',
            userId,
            command.id,
          );
          await db.runAsync(
            'DELETE FROM note_history WHERE user_id=? AND note_id=?',
            userId,
            command.id,
          );
        }
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
        if (row?.previous) await saveRemote(recordSchema.parse(JSON.parse(row.previous)));
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
    merge: async (records, cursor, tombstones = []) => {
      await transaction(async () => {
        for (const item of tombstones) {
          await attachmentStore.cancelForParentInTransaction(item.id);
          await db.runAsync(
            'INSERT INTO tombstones(user_id,id,version) VALUES (?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET version=MAX(version,excluded.version)',
            userId,
            item.id,
            item.version,
          );
          await db.runAsync('DELETE FROM records WHERE user_id=? AND id=?', userId, item.id);
          await db.runAsync(
            'DELETE FROM note_drafts WHERE user_id=? AND note_id=?',
            userId,
            item.id,
          );
          await db.runAsync(
            'DELETE FROM note_history WHERE user_id=? AND note_id=?',
            userId,
            item.id,
          );
          // A permanent deletion wins over queued edits, including failed edits whose
          // rollback snapshots contain the purged content.
          const rows = await db.getAllAsync<OutboxRow>(
            'SELECT * FROM outbox WHERE user_id=?',
            userId,
          );
          for (const row of rows)
            if (targetId(JSON.parse(row.mutation) as Mutation) === item.id)
              await db.runAsync('DELETE FROM outbox WHERE user_id=? AND id=?', userId, row.id);
            else {
              const command = (JSON.parse(row.mutation) as Mutation).command;
              if (command.op === 'note.copyDraft' && command.sourceId === item.id) {
                await db.runAsync('DELETE FROM outbox WHERE user_id=? AND id=?', userId, row.id);
                await db.runAsync(
                  "DELETE FROM records WHERE user_id=? AND id=? AND json_extract(data,'$.version')=0",
                  userId,
                  command.id,
                );
              }
            }
        }
        const queued = await contentPending();
        const protectedIds = new Set(queued.map(targetId));
        for (const item of records) if (!protectedIds.has(item.id)) await saveRemote(item);
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
    attachmentTransfers: attachmentStore.transfers,
    attachmentCache: createAttachmentCacheStore(db, userId, transaction),
    search: (query: SearchQuery) => searchLocal(db, userId, query),
    cacheSearch: async (response: SearchResponse): Promise<SearchResponse> => {
      const groups: SearchResponse['groups'] = [];
      await transaction(async () => {
        const protectedIds = new Set((await contentPending()).map(targetId));
        for (const group of response.groups) {
          const records: RecordItem[] = [];
          for (const item of group.records) {
            if ((await isPurged(item.id)) || protectedIds.has(item.id)) continue;
            const cached = await db.getFirstAsync<{ data: string }>(
              'SELECT data FROM records WHERE user_id=? AND id=?',
              userId,
              item.id,
            );
            if (cached && recordSchema.parse(JSON.parse(cached.data)).version > item.version)
              continue;
            await saveRemote(item);
            records.push(item);
          }
          groups.push({ ...group, records });
        }
      });
      return { groups };
    },
    history: async (noteId: string): Promise<NoteVersion[]> =>
      (
        await db.getAllAsync<{ data: string }>(
          'SELECT data FROM note_history WHERE user_id=? AND note_id=? ORDER BY version DESC',
          userId,
          noteId,
        )
      ).map((r) => noteVersionSchema.parse(JSON.parse(r.data))),
    cacheHistory: async (noteId: string, snapshots: NoteVersion[]) => {
      const validated = noteVersionSchema.array().parse(snapshots);
      if (validated.some((r) => r.noteId !== noteId)) throw new Error('Unexpected note history');
      await transaction(async () => {
        if (await isPurged(noteId)) return;
        for (const snapshot of validated)
          await db.runAsync(
            'INSERT OR REPLACE INTO note_history(user_id,note_id,id,version,data) VALUES (?,?,?,?,?)',
            userId,
            noteId,
            snapshot.id,
            snapshot.version,
            JSON.stringify(snapshot),
          );
      });
    },
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
        if (await isPurged(noteId))
          throw new Error('This note was permanently deleted on another device.');
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
          if (
            mutation.command.op === 'capture' ||
            mutation.command.op === 'note.openDaily' ||
            mutation.command.op === 'note.copyDraft' ||
            mutation.command.op === 'folder.create' ||
            mutation.command.op === 'project.create' ||
            mutation.command.op === 'task.addSubtask'
          )
            await db.runAsync(
              'DELETE FROM records WHERE user_id=? AND id=?',
              userId,
              targetId(mutation),
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
      if (
        chooseTaskScope &&
        taskEditOperations.some((op) => op === mutation.command.op) &&
        !('scope' in mutation.command && mutation.command.scope)
      ) {
        const cached = await db.getFirstAsync<{ data: string }>(
          'SELECT data FROM records WHERE user_id=? AND id=?',
          userId,
          targetId(mutation),
        );
        const record = cached ? recordSchema.parse(JSON.parse(cached.data)) : null;
        if (record?.recurrence) {
          const scope = await chooseTaskScope(record);
          if (scope === null) throw new Error('Task change cancelled.');
          mutation = {
            ...mutation,
            command: { ...mutation.command, scope } as Mutation['command'],
          };
        }
      }
      await transaction(async () => {
        const itemId = targetId(mutation);
        if (await isPurged(itemId)) throw new Error('This item was permanently deleted.');
        if (mutation.command.op === 'note.copyDraft') {
          const copy = mutation.command;
          if (await isPurged(copy.sourceId))
            throw new Error('The original note was permanently deleted.');
          if (
            (await pending()).some(
              (m) => m.command.op === 'note.copyDraft' && m.command.sourceId === copy.sourceId,
            )
          )
            throw new Error('Wait for the existing draft copy to sync.');
        }
        if ((await contentPending()).some((m) => targetId(m) === itemId))
          throw new Error('Wait for the pending change to sync before editing this item again.');
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
