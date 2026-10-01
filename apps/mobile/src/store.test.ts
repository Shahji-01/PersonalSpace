import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { plainTextDocument } from '@personalspace/editor-schema';
import { recordSchema, type Mutation } from '@personalspace/validation';
import { openStore } from './store';

let database: DatabaseSync;
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => randomBytes(count) }));
// Exercise the actual store queries/transactions against SQLite; only the native binding differs.
vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => database.exec(sql),
    runAsync: async (sql: string, ...args: SQLInputValue[]) => database.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: SQLInputValue[]) =>
      database.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: SQLInputValue[]) =>
      database.prepare(sql).get(...args) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      database.exec('BEGIN');
      try {
        await work();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    closeAsync: async () => {},
  }),
}));

beforeEach(() => {
  database = new DatabaseSync(':memory:');
});
afterEach(() => database.close());

describe('durable formatted-note drafts', () => {
  it('recovers drafts when reopening the store and isolates accounts', async () => {
    const a = await openStore('a');
    const id = v7();
    const draft = { content: plainTextDocument('Unsynced draft नमस्ते'), baseVersion: 3 };
    await a.saveDraft(id, draft);
    expect(await (await openStore('a')).loadDraft(id)).toEqual(draft);
    const b = await openStore('b');
    expect(await b.loadDraft(id)).toBeNull();
    await b.discardDraft(id);
    expect(await a.loadDraft(id)).toEqual(draft);
  });
  it('preserves a conflicting edit while restoring the last accepted record', async () => {
    const store = await openStore('a');
    const id = v7();
    const now = new Date().toISOString();
    const original = recordSchema.parse({
      id,
      type: 'note',
      text: 'Original',
      status: 'active',
      plannedDate: null,
      dueDate: null,
      priority: 0,
      parentId: null,
      pinned: false,
      favorite: false,
      archivedAt: null,
      tags: [],
      version: 3,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const content = plainTextDocument('Local edit');
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.updateContent',
        id,
        contentJson: content,
        contentSchemaVersion: 1,
        baseVersion: 3,
      },
    };
    await store.saveDraft(id, { content, baseVersion: 3 });
    await store.enqueue(
      mutation,
      { ...original, text: 'Local edit', contentJson: content },
      original,
    );
    await store.reject(mutation.mutationId, 'Changed on another device');
    expect((await store.list())[0]?.text).toBe('Original');
    expect(await store.loadDraft(id)).toEqual({ content, baseVersion: 3 });
    await store.dismissProblem(mutation.mutationId);
    expect(await store.loadDraft(id)).not.toBeNull();
  });
  it('clears only the acknowledged draft and removes drafts after permanent deletion', async () => {
    const store = await openStore('a');
    const id = v7();
    const content = plainTextDocument('First edit');
    const command = {
      op: 'note.updateContent' as const,
      id,
      contentJson: content,
      contentSchemaVersion: 1 as const,
      baseVersion: 3,
    };
    const first = v7();
    await store.saveDraft(id, { content, baseVersion: 3 });
    await store.enqueue({ mutationId: first, command });
    const newer = { content: plainTextDocument('Newer edit'), baseVersion: 3 };
    await store.saveDraft(id, newer);
    await store.acknowledge(first, []);
    expect(await store.loadDraft(id)).toEqual(newer);
    const second = v7();
    await store.enqueue({
      mutationId: second,
      command: { ...command, contentJson: newer.content },
    });
    await store.acknowledge(second, []);
    expect(await store.loadDraft(id)).toBeNull();
    await store.saveDraft(id, newer);
    const purge = v7();
    await store.enqueue({ mutationId: purge, command: { op: 'note.purge', id, baseVersion: 4 } });
    await store.acknowledge(purge, []);
    expect(await store.loadDraft(id)).toBeNull();
  });
});
