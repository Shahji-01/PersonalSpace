import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  entities,
  attachments,
  entityLinks,
  inboxItems,
  learningCollections,
  learningResources,
  people,
  financeAccounts,
  financeCategories,
  debts,
  financeTransactions,
  transactionSplits,
  notes,
  noteFolders,
  projects,
  recurrenceRules,
  reminders,
  tasks,
  type Transaction,
} from '@personalspace/db';
import { recordSchema, type RecordItem, type Tombstone } from '@personalspace/validation';

export async function scrubRetryRecords(tx: Transaction, userId: string, ids: string[]) {
  if (!ids.length) return;
  const removedIds = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE idempotency_keys k SET response = (
      SELECT coalesce(jsonb_agg(entry ORDER BY ordinal), '[]'::jsonb)
      FROM jsonb_array_elements(k.response) WITH ORDINALITY AS r(entry,ordinal)
      WHERE entry->>'id' NOT IN (${removedIds})
    ) WHERE k.user_id = ${userId} AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(k.response) entry WHERE entry->>'id' IN (${removedIds})
    )
  `);
}

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
  const attachmentRows = await tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), inArray(attachments.id, ids)));
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
  const collectionRows = await tx
    .select()
    .from(learningCollections)
    .where(and(eq(learningCollections.userId, userId), inArray(learningCollections.id, ids)));
  const resourceRows = await tx
    .select()
    .from(learningResources)
    .where(and(eq(learningResources.userId, userId), inArray(learningResources.id, ids)));
  const personRows = await tx
    .select()
    .from(people)
    .where(and(eq(people.userId, userId), inArray(people.id, ids)));
  const accountRows = await tx
    .select()
    .from(financeAccounts)
    .where(and(eq(financeAccounts.userId, userId), inArray(financeAccounts.id, ids)));
  const categoryRows = await tx
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.userId, userId), inArray(financeCategories.id, ids)));
  const debtRows = await tx
    .select()
    .from(debts)
    .where(and(eq(debts.userId, userId), inArray(debts.id, ids)));
  const transactionRows = await tx
    .select()
    .from(financeTransactions)
    .where(and(eq(financeTransactions.userId, userId), inArray(financeTransactions.id, ids)));
  const splitRows = transactionRows.length
    ? await tx
        .select()
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.userId, userId),
            inArray(
              transactionSplits.transactionId,
              transactionRows.map((t) => t.id),
            ),
          ),
        )
    : [];
  const splitsByTx = new Map<string, typeof splitRows>();
  for (const split of splitRows) {
    let arr = splitsByTx.get(split.transactionId);
    if (!arr) {
      arr = [];
      splitsByTx.set(split.transactionId, arr);
    }
    arr.push(split);
  }
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
      | typeof reminders.$inferSelect
      | typeof learningCollections.$inferSelect
      | typeof learningResources.$inferSelect
      | typeof people.$inferSelect
      | typeof financeAccounts.$inferSelect
      | typeof financeCategories.$inferSelect
      | typeof debts.$inferSelect
      | typeof financeTransactions.$inferSelect
      | typeof attachments.$inferSelect,
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
    ...attachmentRows.map((row) =>
      serialize(row, {
        type: 'attachment',
        text: row.filename,
        status: 'active',
        parentId: row.parentId,
        attachment: {
          id: row.id,
          parentId: row.parentId,
          filename: row.filename,
          mime: row.declaredMime,
          size: row.sizeBytes,
          sha256: row.sha256,
          status: row.status,
        },
      }),
    ),
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
    ...collectionRows.map((r) =>
      serialize(r, {
        type: 'collection',
        text: r.name,
        status: 'active',
        parentId: r.parentId,
        sortOrder: r.sortOrder,
      }),
    ),
    ...resourceRows.map((r) =>
      serialize(r, {
        type: 'learning_resource',
        text: r.title,
        status: r.status,
        collectionId: r.collectionId,
        url: r.url,
        resourceType: r.resourceType,
        resourceSource: r.source,
        externalId: r.externalId,
        parentResourceId: r.parentResourceId,
        positionInParent: r.positionInParent,
        author: r.author,
        description: r.description,
        thumbnailUrl: r.thumbnailUrl,
        durationSeconds: r.durationSeconds,
        progressPercent: r.progressPercent,
        progressSeconds: r.progressSeconds,
        progressMode: r.progressMode,
        metadataStatus: r.metadataStatus,
        lastOpenedAt: r.lastOpenedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
      }),
    ),
    ...personRows.map((r) =>
      serialize(r, {
        type: 'person',
        text: r.name,
        status: 'active',
        nickname: r.nickname,
        personNote: r.note,
      }),
    ),
    ...accountRows.map((r) =>
      serialize(r, {
        type: 'account',
        text: r.name,
        status: r.archivedAt ? 'archived' : 'active',
        accountType: r.accountType,
        isLiability: r.isLiability,
        currency: r.currency,
        openingBalanceMinor: r.openingBalanceMinor,
        openingDate: r.openingDate,
        labelLast4: r.labelLast4,
        sortOrder: r.sortOrder,
        cachedBalanceMinor: r.cachedBalanceMinor,
      }),
    ),
    ...categoryRows.map((r) =>
      serialize(r, {
        type: 'category',
        text: r.name,
        status: r.archivedAt ? 'archived' : 'active',
        categoryKind: r.kind,
        parentId: r.parentId,
        categoryIcon: r.icon,
        categoryColor: r.color,
        isSystemSeed: r.isSystemSeed,
      }),
    ),
    ...debtRows.map((r) =>
      serialize(r, {
        type: 'debt',
        text: r.title ?? '',
        status: 'active',
        personId: r.personId,
        debtDirection: r.direction,
        currency: r.currency,
        debtTitle: r.title,
        openedOn: r.openedOn,
        dueOn: r.dueOn,
        manualStatus: r.manualStatus,
        isRunningLedger: r.isRunningLedger,
        cachedOutstandingMinor: r.cachedOutstandingMinor,
      }),
    ),
    ...transactionRows.map((r) =>
      serialize(r, {
        type: 'transaction',
        text: r.description ?? r.merchant ?? '',
        status: r.status,
        transactionType: r.transactionType,
        transactionStatus: r.status,
        accountId: r.accountId,
        toAccountId: r.toAccountId,
        amountMinor: r.amountMinor,
        currency: r.currency,
        toAmountMinor: r.toAmountMinor,
        adjustmentSign: r.adjustmentSign,
        transactionDate: r.transactionDate,
        description: r.description,
        merchant: r.merchant,
        paymentMethod: r.paymentMethod,
        personId: r.personId,
        debtId: r.debtId,
        transactionSource: r.source,
        splits: (splitsByTx.get(r.id) ?? []).map((s) => ({
          id: s.id,
          kind: s.kind,
          categoryId: s.categoryId,
          personId: s.personId,
          debtId: s.debtId,
          amountMinor: s.amountMinor,
          note: s.note,
        })),
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
