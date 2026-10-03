import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  entities,
  entityLinks,
  inboxItems,
  notes,
  noteFolders,
  projects,
  recurrenceRules,
  reminders,
  tasks,
  type Transaction,
} from '@personalspace/db';
import { recordSchema, type RecordItem, type Tombstone } from '@personalspace/validation';

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
  const ruleIds = taskRows.flatMap((task) =>
    task.recurrenceRuleId ? [task.recurrenceRuleId] : [],
  );
  const rules = ruleIds.length
    ? await tx
        .select()
        .from(recurrenceRules)
        .where(and(eq(recurrenceRules.userId, userId), inArray(recurrenceRules.id, ruleIds)))
    : [];
  const folders = await tx
    .select()
    .from(noteFolders)
    .where(and(eq(noteFolders.userId, userId), inArray(noteFolders.id, ids)));
  const projectRows = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), inArray(projects.id, ids)));
  const reminderRows = await tx
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, userId), inArray(reminders.id, ids)));
  const related = await tx
    .select({ sourceId: entityLinks.sourceId, targetId: entityLinks.targetId })
    .from(entityLinks)
    .where(
      and(
        eq(entityLinks.userId, userId),
        inArray(entityLinks.sourceId, ids),
        eq(entityLinks.relation, 'related'),
      ),
    )
    .orderBy(entityLinks.targetId);
  const serialize = (
    row:
      | typeof inboxItems.$inferSelect
      | typeof tasks.$inferSelect
      | typeof notes.$inferSelect
      | typeof noteFolders.$inferSelect
      | typeof projects.$inferSelect
      | typeof reminders.$inferSelect,
    extra: object,
  ) =>
    recordSchema.parse({
      id: row.id,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      plannedDate: null,
      dueDate: null,
      priority: 0,
      parentId: null,
      pinned: false,
      favorite: false,
      archivedAt: null,
      tags: tagsById.get(row.id) ?? [],
      ...extra,
    });
  return [
    ...projectRows.map((r) =>
      serialize(r, {
        type: 'project',
        text: r.name,
        status: r.status,
        color: r.color,
        sortOrder: r.sortOrder,
        relatedNoteIds: related
          .filter((link) => link.sourceId === r.id)
          .map((link) => link.targetId),
      }),
    ),
    ...folders.map((r) =>
      serialize(r, { type: 'folder', text: r.name, status: 'active', parentId: r.parentId }),
    ),
    ...inbox.map((r) => serialize(r, { type: 'inbox', text: r.rawText, status: r.status })),
    ...taskRows.map((r) =>
      serialize(r, {
        type: 'task',
        recurrence: r.recurrenceRuleId
          ? {
              ruleId: r.recurrenceRuleId,
              seriesId: r.recurrenceSeriesId,
              settings: rules.find((rule) => rule.id === r.recurrenceRuleId)?.settings,
              rrule: rules.find((rule) => rule.id === r.recurrenceRuleId)?.rrule,
              occurrenceDate: r.occurrenceDate,
              occurrenceNumber: r.occurrenceNumber,
              nextTaskId: r.nextTaskId,
              advanced: r.recurrenceAdvanced,
            }
          : null,
        text: r.title,
        status: r.status,
        plannedDate: r.plannedDate,
        dueDate: r.dueDate,
        dueTime: r.dueTime?.slice(0, 5) ?? null,
        timeMode: r.timeMode,
        timezone: r.timezone,
        dueAt: r.dueAt?.toISOString() ?? null,
        priority: r.priority,
        parentId: r.parentId,
        projectId: r.projectId,
        completedAt: r.completedAt?.toISOString() ?? null,
        descriptionJson: r.descriptionJson,
        descriptionSchemaVersion: r.descriptionSchemaVersion,
        estimatedMinutes: r.estimatedMinutes,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      }),
    ),
    ...noteRows.map((r) =>
      serialize(r, {
        type: 'note',
        text: r.contentText,
        status: 'active',
        contentJson: r.contentJson,
        contentSchemaVersion: r.contentSchemaVersion,
        recoveredFromId: r.recoveredFromId,
        pinned: r.isPinned,
        favorite: r.isFavorite,
        archivedAt: r.archivedAt?.toISOString() ?? null,
        folderId: r.folderId,
        kind: r.kind,
        dailyDate: r.dailyDate,
      }),
    ),
    ...reminderRows.map((r) =>
      serialize(r, {
        type: 'reminder',
        text: r.title,
        status: r.status,
        entityId: r.entityId,
        remindDate: r.remindDate,
        remindTime: r.remindTime?.slice(0, 5) ?? null,
        timeMode: r.timeMode,
        timezone: r.timezone,
        fireAt: r.fireAt?.toISOString() ?? null,
        snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
        lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
      }),
    ),
  ].sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));
}
export async function changedEntities(
  tx: Transaction,
  userId: string,
  cursor: number,
  full = false,
) {
  const cutoff = sql`now() - interval '180 days'`;
  // Select distinct versions first: never split a transaction across pages.
  const versions = await tx
    .selectDistinct({ version: entities.version })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        gt(entities.version, cursor),
        full ? undefined : or(isNull(entities.purgedAt), gte(entities.purgedAt, cutoff)),
      ),
    )
    .orderBy(entities.version)
    .limit(101);
  const included = versions.slice(0, 100).map((v) => v.version);
  const rows = included.length
    ? await tx
        .select({ id: entities.id, version: entities.version, purgedAt: entities.purgedAt })
        .from(entities)
        .where(and(eq(entities.userId, userId), inArray(entities.version, included)))
    : [];
  return {
    ids: rows.filter((r) => !r.purgedAt).map((r) => r.id),
    tombstones: rows
      .filter((r) => r.purgedAt)
      .map((r): Tombstone => ({
        id: r.id,
        version: r.version,
        purgedAt: r.purgedAt!.toISOString(),
      })),
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
export async function trashedInboxFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(inboxItems)
      .where(
        and(eq(inboxItems.id, id), eq(inboxItems.userId, userId), isNotNull(inboxItems.deletedAt)),
      )
  )[0];
}
export const nextVersion = sql`version + 1`;
