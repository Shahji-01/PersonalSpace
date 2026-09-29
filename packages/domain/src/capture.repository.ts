import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { entities, inboxItems, notes, tasks, type Transaction } from '@personalspace/db';
import { recordSchema, type RecordItem } from '@personalspace/validation';

export async function recordsFor(
  tx: Transaction,
  userId: string,
  ids: string[],
): Promise<RecordItem[]> {
  if (!ids.length) return [];
  // A transaction owns one PostgreSQL connection; queries on it must run sequentially.
  const tagRows = await tx
    .select({ id: entities.id, tags: entities.tags })
    .from(entities)
    .where(and(eq(entities.userId, userId), inArray(entities.id, ids)));
  const tagsById = new Map(tagRows.map((r) => [r.id, r.tags]));
  const inbox = await tx
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), inArray(inboxItems.id, ids)));
  const taskRows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
  const noteRows = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), inArray(notes.id, ids)));
  const serialize = (
    row: typeof inboxItems.$inferSelect | typeof tasks.$inferSelect | typeof notes.$inferSelect,
    extra: object,
  ) =>
    recordSchema.parse({
      id: row.id,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      plannedDate: null,
      parentId: null,
      tags: tagsById.get(row.id) ?? [],
      ...extra,
    });
  return [
    ...inbox.map((r) => serialize(r, { type: 'inbox', text: r.rawText, status: r.status })),
    ...taskRows.map((r) =>
      serialize(r, {
        type: 'task',
        text: r.title,
        status: r.status,
        plannedDate: r.plannedDate,
        parentId: r.parentId,
      }),
    ),
    ...noteRows.map((r) => serialize(r, { type: 'note', text: r.contentText, status: 'active' })),
  ].sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));
}
export async function changedEntities(tx: Transaction, userId: string, cursor: number) {
  // Select distinct versions first: never split a transaction across pages.
  const versions = await tx
    .selectDistinct({ version: entities.version })
    .from(entities)
    .where(and(eq(entities.userId, userId), gt(entities.version, cursor)))
    .orderBy(entities.version)
    .limit(101);
  const included = versions.slice(0, 100).map((v) => v.version);
  const rows = included.length
    ? await tx
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.userId, userId), inArray(entities.version, included)))
    : [];
  return {
    ids: rows.map((r) => r.id),
    nextCursor: included.at(-1) ?? cursor,
    hasMore: versions.length > 100,
  };
}
export async function taskFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
  )[0];
}
export async function noteFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)))
  )[0];
}
export async function trashedNoteFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNotNull(notes.deletedAt)))
  )[0];
}
export async function trashedTaskFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNotNull(tasks.deletedAt)))
  )[0];
}
export async function inboxFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(inboxItems)
      .where(
        and(eq(inboxItems.id, id), eq(inboxItems.userId, userId), isNull(inboxItems.deletedAt)),
      )
  )[0];
}
export const nextVersion = sql`version + 1`;
