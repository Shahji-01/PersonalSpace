import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  entities,
  syncState,
  tasks,
  notes,
  noteVersions,
  noteFolders,
  projects,
  reminders,
  learningCollections,
  learningResources,
  inboxItems,
  entityLinks,
  idempotencyKeys,
  auditLogs,
  outboxEvents,
  withUser,
  type Database,
  type Transaction,
} from '@personalspace/db';
import {
  commandSchema,
  fixedDeadlineInstant,
  DeadlineTimeError,
  recordSchema,
  type Capture,
  type Command,
  type RecordItem,
} from '@personalspace/validation';
import {
  changedEntities,
  inboxFor,
  nextVersion,
  noteFor,
  recordsFor,
  taskFor,
  trashedInboxFor,
  trashedNoteFor,
  trashedTaskFor,
} from './capture.repository';
import { DomainError } from './errors';
import {
  setRecurrence,
  updateFutureRecurrence,
  advanceRecurrence,
  purgeUnusedRecurrence,
} from './task-recurrence';
import { snapshotNote, checkpointNote } from './note-history';
import { indexSearchRecords } from './search';
import { applyFolderCommand, requireFolder } from './folders';
import { applyProjectCommand, requireProject } from './projects';
import { replaceNoteReferences, validateNoteReferences } from './note-references';
import {
  createReminder,
  updateReminder,
  snoozeReminder,
  setReminderStatus,
  reminderFor,
  trashedReminderFor,
} from './reminders';
import {
  createCollection,
  renameCollection,
  moveCollection,
  collectionFor,
  saveResource,
  updateResource,
  setResourceStatus,
  setResourceProgress,
  setResourceCollection,
  resourceFor,
  trashedResourceFor,
} from './learning';
import {
  documentText,
  hasFormatting,
  plainTextDocument,
  readDocument,
} from '@personalspace/editor-schema';

// Plain text maps to a ProseMirror-compatible document. Title is the first line, matching
// how notes are first created so edits round-trip the same way through the record contract.
function noteContent(text: string) {
  return {
    title: text.split('\n')[0]!.slice(0, 120),
    contentText: text,
    contentJson: plainTextDocument(text),
    contentSchemaVersion: 1,
  };
}

async function insertCapture(tx: Transaction, userId: string, version: number, input: Capture) {
  const std = { id: input.id, userId, version };
  // ON CONFLICT does not disclose whether a colliding UUID belongs to another user.
  const inserted = await tx
    .insert(entities)
    .values({ ...std, type: input.type })
    .onConflictDoNothing()
    .returning({ id: entities.id });
  if (!inserted.length) throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
  if (input.type === 'inbox') await tx.insert(inboxItems).values({ ...std, rawText: input.text });
  if (input.type === 'task')
    await tx.insert(tasks).values({
      ...std,
      title: input.text,
      plannedDate: input.plannedDate,
      dueDate: input.dueDate ?? null,
    });
  if (input.type === 'note') await tx.insert(notes).values({ ...std, ...noteContent(input.text) });
}

async function purgeRecords(tx: Transaction, userId: string, ids: string[], version: number) {
  const removedTasks = await tx
    .select({ ruleId: tasks.recurrenceRuleId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
  const relatedProjects = await tx
    .selectDistinct({ id: projects.id })
    .from(entityLinks)
    .innerJoin(projects, and(eq(projects.id, entityLinks.sourceId), eq(projects.userId, userId)))
    .where(
      and(
        eq(entityLinks.userId, userId),
        inArray(entityLinks.targetId, ids),
        eq(entityLinks.relation, 'related'),
      ),
    );
  await tx
    .update(inboxItems)
    .set({ convertedEntityId: null })
    .where(and(eq(inboxItems.userId, userId), inArray(inboxItems.convertedEntityId, ids)));
  await tx
    .delete(entityLinks)
    .where(
      and(
        eq(entityLinks.userId, userId),
        or(inArray(entityLinks.sourceId, ids), inArray(entityLinks.targetId, ids)),
      ),
    );
  await tx.delete(notes).where(and(eq(notes.userId, userId), inArray(notes.id, ids)));
  await tx.delete(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
  await tx.delete(reminders).where(and(eq(reminders.userId, userId), inArray(reminders.id, ids)));
  await tx.delete(learningResources).where(and(eq(learningResources.userId, userId), inArray(learningResources.id, ids)));
  await tx.delete(learningCollections).where(and(eq(learningCollections.userId, userId), inArray(learningCollections.id, ids)));
  await purgeUnusedRecurrence(
    tx,
    userId,
    removedTasks.flatMap((task) => (task.ruleId ? [task.ruleId] : [])),
  );
  await tx
    .delete(inboxItems)
    .where(and(eq(inboxItems.userId, userId), inArray(inboxItems.id, ids)));
  await tx
    .delete(noteFolders)
    .where(and(eq(noteFolders.userId, userId), inArray(noteFolders.id, ids)));
  const now = new Date();
  await tx
    .update(entities)
    .set({ purgedAt: now, deletedAt: now, updatedAt: now, tags: [], version })
    .where(and(eq(entities.userId, userId), inArray(entities.id, ids)));
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
  const affected = relatedProjects.map((row) => row.id);
  if (affected.length)
    await tx
      .update(projects)
      .set({ version, updatedAt: now })
      .where(and(eq(projects.userId, userId), inArray(projects.id, affected)));
  return affected;
}

export function createCaptureService(db: Database) {
  async function execute(
    userId: string,
    key: string,
    raw: Command,
    requestId: string,
  ): Promise<RecordItem[]> {
    const command = commandSchema.parse(raw);
    // Zod reconstructs objects in schema order, so JSON key order cannot change the request hash.
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return withUser(db, userId, async (tx) => {
      // This is the first data lock for every write. All mutations for a user commit in order.
      await tx.insert(syncState).values({ userId }).onConflictDoNothing();
      const [state] = await tx
        .update(syncState)
        .set({ version: nextVersion })
        .where(eq(syncState.userId, userId))
        .returning();
      if (!state) throw new Error('Missing sync state');
      const [previous] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
      if (previous) {
        if (previous.requestHash !== hash)
          throw new DomainError(
            'IDEMPOTENCY_KEY_REUSED',
            'This retry key was already used for a different action.',
            422,
          );
        return recordSchema.array().parse(previous.response);
      }
      const version = state.version;
      let ids: string[];
      if (command.op === 'capture') {
        await insertCapture(tx, userId, version, command.payload);
        ids = [command.payload.id];
      } else if (command.op === 'note.copyDraft') {
        const source = await noteFor(tx, userId, command.sourceId);
        if (!source)
          throw new DomainError(
            'NOTE_NOT_FOUND',
            'The original note is unavailable. Restore it from Trash before recovering this draft.',
            404,
          );
        if (command.sourceBaseVersion > source.version)
          throw new DomainError(
            'VERSION_CONFLICT',
            'Refresh the original note before copying this draft.',
          );
        const inserted = await tx
          .insert(entities)
          .values({ id: command.id, userId, type: 'note', version })
          .onConflictDoNothing()
          .returning({ id: entities.id });
        if (!inserted.length)
          throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
        const text = documentText(command.contentJson);
        await tx.insert(notes).values({
          id: command.id,
          userId,
          version,
          title: `${text.split('\n')[0]!.slice(0, 100)} (recovered draft)`,
          contentText: text,
          contentJson: command.contentJson,
          contentSchemaVersion: 1,
          recoveredFromId: source.id,
          folderId: source.folderId,
        });
        await replaceNoteReferences(tx, userId, command.id, command.contentJson, version);
        ids = [command.id];
      } else if (command.op === 'note.checkpoint') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed elsewhere. Your local draft is preserved.',
          );
        await validateNoteReferences(tx, userId, command.contentJson);
        await checkpointNote(tx, userId, note.id, version, command.contentJson, command.reason);
        await tx
          .insert(auditLogs)
          .values({ id: uuidv7(), userId, action: command.op, entityId: note.id, requestId });
        // Checkpoints preserve the published note and its base version. History is
        // refreshed independently when opened; the response contains no draft content.
        ids = [];
      } else if (command.op === 'note.openDaily') {
        // The per-user sync lock serializes different devices opening the same day.
        const [existing] = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.userId, userId),
              eq(notes.kind, 'daily'),
              eq(notes.dailyDate, command.date),
              isNull(notes.deletedAt),
            ),
          );
        if (existing) {
          const response = await recordsFor(tx, userId, [existing.id]);
          await tx.insert(idempotencyKeys).values({ userId, key, requestHash: hash, response });
          return response;
        }
        await insertCapture(tx, userId, version, {
          id: command.id,
          type: 'note',
          text: command.date,
          plannedDate: null,
        });
        await tx
          .update(notes)
          .set({ kind: 'daily', dailyDate: command.date })
          .where(and(eq(notes.id, command.id), eq(notes.userId, userId)));
        ids = [command.id];
      } else if (
        command.op === 'project.create' ||
        command.op === 'project.setNotes' ||
        command.op === 'project.update' ||
        command.op === 'project.setArchived' ||
        command.op === 'project.move'
      ) {
        ids = await applyProjectCommand(tx, userId, version, command);
      } else if (command.op === 'task.setProject') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.parentId)
          throw new DomainError(
            'SUBTASK_PROJECT',
            'Change the parent task’s project to move its subtasks.',
            422,
          );
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        if (command.projectId) {
          const project = await requireProject(tx, userId, command.projectId);
          if (project.status === 'archived')
            throw new DomainError(
              'PROJECT_ARCHIVED',
              'Unarchive this project before adding tasks.',
              422,
            );
        }
        const changed = await tx
          .update(tasks)
          .set({ projectId: command.projectId, version, updatedAt: new Date() })
          .where(
            and(eq(tasks.userId, userId), or(eq(tasks.id, task.id), eq(tasks.parentId, task.id))),
          )
          .returning({ id: tasks.id });
        ids = changed.map((r) => r.id);
      } else if (
        command.op === 'folder.create' ||
        command.op === 'folder.rename' ||
        command.op === 'folder.move' ||
        command.op === 'folder.delete'
      ) {
        await applyFolderCommand(tx, userId, version, command);
        ids = [command.id];
        if (command.op === 'folder.delete')
          ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (command.op === 'note.setFolder') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        if (command.folderId) await requireFolder(tx, userId, command.folderId);
        await tx
          .update(notes)
          .set({ folderId: command.folderId, version, updatedAt: new Date() })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'inbox.convert') {
        const item = await inboxFor(tx, userId, command.id);
        if (!item) throw new DomainError('INBOX_NOT_FOUND', 'This inbox item was not found.', 404);
        if (item.status !== 'new')
          throw new DomainError('ALREADY_CONVERTED', 'This inbox item was already filed.');
        if (item.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        if (command.targetType === 'task' && item.rawText.length > 500)
          throw new DomainError(
            'TASK_TITLE_TOO_LONG',
            'Save this as a note; task titles must fit in 500 characters.',
            422,
          );
        await insertCapture(tx, userId, version, {
          id: command.targetId,
          type: command.targetType,
          text: item.rawText,
          plannedDate: null,
        });
        await tx
          .update(inboxItems)
          .set({
            status: 'converted',
            convertedEntityId: command.targetId,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(inboxItems.id, item.id), eq(inboxItems.userId, userId)));
        await tx.insert(entityLinks).values({
          id: uuidv7(),
          userId,
          version,
          sourceId: command.targetId,
          targetId: item.id,
          relation: 'converted_from',
        });
        ids = [item.id, command.targetId];
      } else if (command.op === 'note.restoreVersion') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh before restoring.',
          );
        const [snapshot] = await tx
          .select()
          .from(noteVersions)
          .where(
            and(
              eq(noteVersions.id, command.versionId),
              eq(noteVersions.noteId, note.id),
              eq(noteVersions.userId, userId),
            ),
          );
        if (!snapshot)
          throw new DomainError(
            'NOTE_VERSION_NOT_FOUND',
            'This version is no longer available.',
            404,
          );
        const content = readDocument(snapshot.contentJson, snapshot.contentSchemaVersion);
        await replaceNoteReferences(tx, userId, note.id, content, version);
        await tx
          .update(notes)
          .set({
            title: snapshot.title,
            contentJson: content,
            contentText: documentText(content),
            contentSchemaVersion: snapshot.contentSchemaVersion,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'note.updateContent') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Your local draft is preserved.',
          );
        const text = documentText(command.contentJson);
        await replaceNoteReferences(tx, userId, note.id, command.contentJson, version);
        await tx
          .update(notes)
          .set({
            contentJson: command.contentJson,
            contentSchemaVersion: command.contentSchemaVersion,
            contentText: text,
            title: text.split('\n')[0]!.slice(0, 120) || 'Untitled note',
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'note.edit') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        if (hasFormatting(readDocument(note.contentJson, note.contentSchemaVersion)))
          throw new DomainError(
            'RICH_TEXT_REQUIRED',
            'Update the app to edit this formatted note.',
            422,
          );
        await tx
          .update(notes)
          .set({ ...noteContent(command.text), version, updatedAt: new Date() })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'note.delete') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        const now = new Date();
        await tx
          .update(notes)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'note.restore') {
        const note = await trashedNoteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not in Trash.', 404);
        if (note.dailyDate) {
          const [existing] = await tx
            .select({ id: notes.id })
            .from(notes)
            .where(
              and(
                eq(notes.userId, userId),
                eq(notes.kind, 'daily'),
                eq(notes.dailyDate, note.dailyDate),
                isNull(notes.deletedAt),
              ),
            );
          if (existing)
            throw new DomainError(
              'DAILY_NOTE_EXISTS',
              'Another daily note exists for this date. Move it to Trash before restoring this one.',
              409,
            );
        }
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        await tx
          .update(notes)
          .set({ deletedAt: null, version, updatedAt: new Date() })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (command.op === 'note.purge') {
        // Remove private content and preserve an ordered deletion marker for offline devices.
        const note = await trashedNoteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not in Trash.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        ids = [note.id];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (
        command.op === 'note.setPinned' ||
        command.op === 'note.setFavorite' ||
        command.op === 'note.setArchived'
      ) {
        // Pin, favorite and archive are orthogonal note flags; archiving hides a note from the
        // active list without deleting it. All operate on a live (non-trashed) note.
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        const patch =
          command.op === 'note.setPinned'
            ? { isPinned: command.pinned }
            : command.op === 'note.setFavorite'
              ? { isFavorite: command.favorite }
              : { archivedAt: command.archived ? new Date() : null };
        await tx
          .update(notes)
          .set({ ...patch, version, updatedAt: new Date() })
          .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
        ids = [note.id];
      } else if (
        command.op === 'task.updateDescription' ||
        command.op === 'task.setEstimate' ||
        command.op === 'task.setArchived'
      ) {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const patch =
          command.op === 'task.updateDescription'
            ? {
                descriptionJson: command.contentJson,
                descriptionSchemaVersion: command.contentSchemaVersion,
                descriptionText: documentText(command.contentJson),
              }
            : command.op === 'task.setEstimate'
              ? { estimatedMinutes: command.estimatedMinutes }
              : { archivedAt: command.archived ? new Date() : null };
        await tx
          .update(tasks)
          .set({ ...patch, version, updatedAt: new Date() })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'task.setRecurrence') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed elsewhere. Refresh and try again.',
          );
        await setRecurrence(tx, userId, task, command.recurrence, version);
        ids = [task.id];
      } else if (command.op === 'task.setStatus') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const completedAt = command.occurredAt ? new Date(command.occurredAt) : new Date();
        if (completedAt.getTime() > Date.now() + 300000)
          throw new DomainError(
            'INVALID_COMPLETION_TIME',
            'Check your device clock and try again.',
            422,
          );
        const successors =
          command.status === 'done' || command.status === 'cancelled'
            ? await advanceRecurrence(
                tx,
                userId,
                task,
                version,
                completedAt,
                command.currentTimezone,
              )
            : [];
        await tx
          .update(tasks)
          .set({
            status: command.status,
            completedAt: command.status === 'done' ? completedAt : null,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id, ...successors];
      } else if (command.op === 'task.reschedule') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        await tx
          .update(tasks)
          .set({ plannedDate: command.plannedDate, version, updatedAt: new Date() })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'task.addSubtask') {
        const parent = await taskFor(tx, userId, command.parentId);
        if (!parent) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (parent.parentId)
          throw new DomainError('SUBTASK_NESTING', 'Subtasks cannot have their own subtasks.', 422);
        if (parent.recurrenceRuleId) {
          const children = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(eq(tasks.userId, userId), eq(tasks.parentId, parent.id), isNull(tasks.deletedAt)),
            )
            .limit(100);
          if (children.length >= 100)
            throw new DomainError(
              'RECURRENCE_SUBTASK_LIMIT',
              'Repeating tasks support up to 100 subtasks.',
              422,
            );
        }
        const inserted = await tx
          .insert(entities)
          .values({ id: command.id, userId, version, type: 'task' })
          .onConflictDoNothing()
          .returning({ id: entities.id });
        if (!inserted.length)
          throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
        await tx.insert(tasks).values({
          id: command.id,
          userId,
          version,
          title: command.text,
          parentId: parent.id,
          projectId: parent.projectId,
          plannedDate: null,
        });
        ids = [command.id];
      } else if (command.op === 'task.rename') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        await tx
          .update(tasks)
          .set({ title: command.text, version, updatedAt: new Date() })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'task.delete') {
        // Trashing a task cascades to its active subtasks so none are left orphaned; they all
        // move to Trash together on the same version.
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const subs = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(eq(tasks.userId, userId), eq(tasks.parentId, task.id), isNull(tasks.deletedAt)),
          );
        const targetIds = [task.id, ...subs.map((s) => s.id)];
        const now = new Date();
        await tx
          .update(tasks)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(tasks.userId, userId), inArray(tasks.id, targetIds)));
        ids = targetIds;
      } else if (command.op === 'task.restore') {
        const task = await trashedTaskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not in Trash.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const subs = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(eq(tasks.userId, userId), eq(tasks.parentId, task.id), isNotNull(tasks.deletedAt)),
          );
        const targetIds = [task.id, ...subs.map((s) => s.id)];
        await tx
          .update(tasks)
          .set({ deletedAt: null, version, updatedAt: new Date() })
          .where(and(eq(tasks.userId, userId), inArray(tasks.id, targetIds)));
        ids = targetIds;
      } else if (command.op === 'task.purge') {
        // Parent and children share a deletion version, so pull never splits the cascade.
        const task = await trashedTaskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not in Trash.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const subs = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.parentId, task.id)));
        const subIds = subs.map((s) => s.id);
        ids = [task.id, ...subIds];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (command.op === 'item.setTags') {
        // Tags live on the entity, so one command labels any item type. Deleted items keep
        // their tags but are not tagged from the UI.
        const [entity] = await tx
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.id, command.id),
              eq(entities.userId, userId),
              isNull(entities.deletedAt),
            ),
          );
        if (!entity) throw new DomainError('ITEM_NOT_FOUND', 'This item was not found.', 404);
        if (entity.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        await tx
          .update(entities)
          .set({ tags: command.tags })
          .where(and(eq(entities.id, entity.id), eq(entities.userId, userId)));
        // recordsFor reports the version from the type table, so keep it in step with the
        // entity version the tail bumps below; otherwise the next tag edit would misfire.
        const patch = { version, updatedAt: new Date() };
        const where = and(eq(tasks.id, entity.id), eq(tasks.userId, userId));
        if (entity.type === 'task') await tx.update(tasks).set(patch).where(where);
        else if (entity.type === 'project')
          await tx
            .update(projects)
            .set(patch)
            .where(and(eq(projects.id, entity.id), eq(projects.userId, userId)));
        else if (entity.type === 'folder')
          await tx
            .update(noteFolders)
            .set(patch)
            .where(and(eq(noteFolders.id, entity.id), eq(noteFolders.userId, userId)));
        else if (entity.type === 'note')
          await tx
            .update(notes)
            .set(patch)
            .where(and(eq(notes.id, entity.id), eq(notes.userId, userId)));
        else
          await tx
            .update(inboxItems)
            .set(patch)
            .where(and(eq(inboxItems.id, entity.id), eq(inboxItems.userId, userId)));
        ids = [entity.id];
      } else if (command.op === 'inbox.delete') {
        // Only an unfiled capture can be dismissed; a converted item is preserved as provenance.
        const item = await inboxFor(tx, userId, command.id);
        if (!item) throw new DomainError('INBOX_NOT_FOUND', 'This inbox item was not found.', 404);
        if (item.status !== 'new')
          throw new DomainError('ALREADY_CONVERTED', 'This inbox item was already filed.');
        if (item.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        const now = new Date();
        await tx
          .update(inboxItems)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(inboxItems.id, item.id), eq(inboxItems.userId, userId)));
        ids = [item.id];
      } else if (command.op === 'inbox.restore') {
        const item = await trashedInboxFor(tx, userId, command.id);
        if (!item)
          throw new DomainError('INBOX_NOT_FOUND', 'This inbox item was not in Trash.', 404);
        if (item.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        await tx
          .update(inboxItems)
          .set({ deletedAt: null, version, updatedAt: new Date() })
          .where(and(eq(inboxItems.id, item.id), eq(inboxItems.userId, userId)));
        ids = [item.id];
      } else if (command.op === 'inbox.purge') {
        const item = await trashedInboxFor(tx, userId, command.id);
        if (!item)
          throw new DomainError('INBOX_NOT_FOUND', 'This inbox item was not in Trash.', 404);
        if (item.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        ids = [item.id];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (command.op === 'task.setPriority') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        await tx
          .update(tasks)
          .set({ priority: command.priority, version, updatedAt: new Date() })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'task.setDeadline') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        let dueAt: string | null;
        try {
          dueAt = fixedDeadlineInstant(command.deadline);
        } catch (error) {
          if (error instanceof DeadlineTimeError)
            throw new DomainError(error.code, error.message, 422);
          throw error;
        }
        const { dueDate, dueTime, timeMode, timezone } = command.deadline;
        await tx
          .update(tasks)
          .set({
            dueDate,
            dueTime,
            timeMode,
            timezone,
            dueAt: dueAt ? new Date(dueAt) : null,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'task.setDueDate') {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        await tx
          .update(tasks)
          .set({
            dueDate: command.dueDate,
            dueTime: null,
            timeMode: 'floating',
            timezone: null,
            dueAt: null,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      } else if (command.op === 'reminder.create') {
        const inserted = await tx
          .insert(entities)
          .values({ id: command.id, userId, type: 'reminder', version })
          .onConflictDoNothing()
          .returning({ id: entities.id });
        if (!inserted.length)
          throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
        if (command.entityId) {
          // Verify the attached entity exists and belongs to this user.
          const [target] = await tx
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                eq(entities.id, command.entityId),
                eq(entities.userId, userId),
                isNull(entities.purgedAt),
              ),
            );
          if (!target)
            throw new DomainError(
              'ENTITY_NOT_FOUND',
              'The item you are attaching this reminder to was not found.',
              404,
            );
        }
        ids = await createReminder(tx, userId, command.id, version, {
          entityId: command.entityId,
          title: command.title,
          remindDate: command.remindDate,
          remindTime: command.remindTime,
          timeMode: command.timeMode,
          timezone: command.timezone,
        });
      } else if (command.op === 'reminder.update') {
        ids = await updateReminder(tx, userId, command.id, version, command.baseVersion, {
          title: command.title,
          remindDate: command.remindDate,
          remindTime: command.remindTime,
          timeMode: command.timeMode,
          timezone: command.timezone,
        });
      } else if (command.op === 'reminder.snooze') {
        ids = await snoozeReminder(
          tx,
          userId,
          command.id,
          version,
          command.baseVersion,
          command.duration,
          command.currentTimezone,
        );
      } else if (command.op === 'reminder.dismiss') {
        ids = await setReminderStatus(tx, userId, command.id, version, command.baseVersion, 'dismissed');
      } else if (command.op === 'reminder.done') {
        ids = await setReminderStatus(tx, userId, command.id, version, command.baseVersion, 'done');
      } else if (command.op === 'reminder.cancel') {
        ids = await setReminderStatus(tx, userId, command.id, version, command.baseVersion, 'cancelled');
      } else if (command.op === 'reminder.delete') {
        const reminder = await reminderFor(tx, userId, command.id);
        if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not found.', 404);
        if (reminder.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This reminder changed on another device. Refresh and try again.');
        const now = new Date();
        await tx
          .update(reminders)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(reminders.id, reminder.id), eq(reminders.userId, userId)));
        ids = [reminder.id];
      } else if (command.op === 'reminder.restore') {
        const reminder = await trashedReminderFor(tx, userId, command.id);
        if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not in Trash.', 404);
        if (reminder.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This reminder changed on another device. Refresh and try again.');
        await tx
          .update(reminders)
          .set({ deletedAt: null, version, updatedAt: new Date() })
          .where(and(eq(reminders.id, reminder.id), eq(reminders.userId, userId)));
        ids = [reminder.id];
      } else if (command.op === 'reminder.purge') {
        const reminder = await trashedReminderFor(tx, userId, command.id);
        if (!reminder) throw new DomainError('REMINDER_NOT_FOUND', 'This reminder was not in Trash.', 404);
        if (reminder.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This reminder changed on another device. Refresh and try again.');
        ids = [reminder.id];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (command.op === 'collection.create') {
        const inserted = await tx
          .insert(entities)
          .values({ id: command.id, userId, type: 'collection', version })
          .onConflictDoNothing()
          .returning({ id: entities.id });
        if (!inserted.length)
          throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
        ids = await createCollection(tx, userId, command.id, version, command.name, command.parentId);
      } else if (command.op === 'collection.rename') {
        ids = await renameCollection(tx, userId, command.id, version, command.baseVersion, command.name);
      } else if (command.op === 'collection.move') {
        ids = await moveCollection(tx, userId, command.id, version, command.baseVersion, command.parentId);
      } else if (command.op === 'collection.delete') {
        const collection = await collectionFor(tx, userId, command.id);
        if (!collection) throw new DomainError('COLLECTION_NOT_FOUND', 'This collection was not found.', 404);
        if (collection.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This collection changed on another device. Refresh and try again.');
        // Detach resources from this collection.
        await tx
          .update(learningResources)
          .set({ collectionId: null, version, updatedAt: new Date() })
          .where(and(eq(learningResources.userId, userId), eq(learningResources.collectionId, collection.id)));
        // Detach child collections.
        await tx
          .update(learningCollections)
          .set({ parentId: null, version, updatedAt: new Date() })
          .where(and(eq(learningCollections.userId, userId), eq(learningCollections.parentId, collection.id)));
        const now = new Date();
        await tx
          .update(learningCollections)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(learningCollections.id, collection.id), eq(learningCollections.userId, userId)));
        ids = [collection.id];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else if (command.op === 'resource.save') {
        const inserted = await tx
          .insert(entities)
          .values({ id: command.id, userId, type: 'learning_resource', version })
          .onConflictDoNothing()
          .returning({ id: entities.id });
        if (!inserted.length)
          throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
        ids = await saveResource(tx, userId, command.id, version, {
          url: command.url,
          title: command.title,
          resourceType: command.resourceType,
          source: command.source,
          collectionId: command.collectionId,
          externalId: command.externalId,
        });
      } else if (command.op === 'resource.update') {
        ids = await updateResource(tx, userId, command.id, version, command.baseVersion, {
          title: command.title,
          author: command.author,
          description: command.description,
          resourceType: command.resourceType,
        });
      } else if (command.op === 'resource.setStatus') {
        ids = await setResourceStatus(tx, userId, command.id, version, command.baseVersion, command.status);
      } else if (command.op === 'resource.setProgress') {
        ids = await setResourceProgress(
          tx, userId, command.id, version, command.baseVersion,
          command.progressPercent, command.progressSeconds, command.progressMode,
        );
      } else if (command.op === 'resource.setCollection') {
        ids = await setResourceCollection(tx, userId, command.id, version, command.baseVersion, command.collectionId);
      } else if (command.op === 'resource.delete') {
        const resource = await resourceFor(tx, userId, command.id);
        if (!resource) throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not found.', 404);
        if (resource.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This resource changed on another device. Refresh and try again.');
        const now = new Date();
        await tx
          .update(learningResources)
          .set({ deletedAt: now, version, updatedAt: now })
          .where(and(eq(learningResources.id, resource.id), eq(learningResources.userId, userId)));
        ids = [resource.id];
      } else if (command.op === 'resource.restore') {
        const resource = await trashedResourceFor(tx, userId, command.id);
        if (!resource) throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not in Trash.', 404);
        if (resource.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This resource changed on another device. Refresh and try again.');
        await tx
          .update(learningResources)
          .set({ deletedAt: null, version, updatedAt: new Date() })
          .where(and(eq(learningResources.id, resource.id), eq(learningResources.userId, userId)));
        ids = [resource.id];
      } else if (command.op === 'resource.purge') {
        const resource = await trashedResourceFor(tx, userId, command.id);
        if (!resource) throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not in Trash.', 404);
        if (resource.version !== command.baseVersion)
          throw new DomainError('VERSION_CONFLICT', 'This resource changed on another device. Refresh and try again.');
        ids = [resource.id];
        ids.push(...(await purgeRecords(tx, userId, ids, version)));
      } else {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const done = command.op === 'task.complete';
        const completedAt = done && command.occurredAt ? new Date(command.occurredAt) : new Date();
        if (completedAt.getTime() > Date.now() + 300000)
          throw new DomainError(
            'INVALID_COMPLETION_TIME',
            'Check your device clock and try again.',
            422,
          );
        const successors = done
          ? await advanceRecurrence(tx, userId, task, version, completedAt, command.currentTimezone)
          : [];
        await tx
          .update(tasks)
          .set({
            status: done ? 'done' : 'todo',
            completedAt: done ? completedAt : null,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id, ...successors];
      }
      if ('scope' in command && command.scope === 'future') {
        const task = await taskFor(tx, userId, command.id);
        if (task) await updateFutureRecurrence(tx, userId, task, version);
      }
      if (
        command.op === 'capture' ||
        command.op === 'note.openDaily' ||
        command.op === 'note.copyDraft' ||
        command.op === 'inbox.convert' ||
        command.op === 'note.edit' ||
        command.op === 'note.updateContent' ||
        command.op === 'note.restoreVersion'
      ) {
        for (const id of ids)
          await snapshotNote(
            tx,
            userId,
            id,
            command.op === 'note.restoreVersion' ? 'restore' : 'session_end',
          );
      }
      for (const id of ids) {
        await tx
          .update(entities)
          .set({
            version,
            updatedAt: new Date(),
            ...(command.op.endsWith('.delete') ? { deletedAt: new Date() } : {}),
            ...(command.op.endsWith('.restore') ? { deletedAt: null } : {}),
          })
          .where(and(eq(entities.id, id), eq(entities.userId, userId)));
        await tx
          .insert(auditLogs)
          .values({ id: uuidv7(), userId, action: command.op, entityId: id, requestId });
      }
      await tx.insert(outboxEvents).values({
        id: uuidv7(),
        userId,
        type: 'entities.changed',
        payload: { entityIds: ids, version },
      });
      const records = await recordsFor(tx, userId, ids);
      await indexSearchRecords(tx, userId, ids, records);
      await tx
        .insert(idempotencyKeys)
        .values({ userId, key, requestHash: hash, response: records });
      return records;
    });
  }
  async function pull(userId: string, cursor: number, full = false) {
    return withUser(
      db,
      userId,
      async (tx) => {
        const [state] = await tx
          .select({ version: syncState.version })
          .from(syncState)
          .where(eq(syncState.userId, userId));
        const watermark = state?.version ?? 0;
        const [expired] = await tx
          .select({ floor: sql<number>`coalesce(max(${entities.version}),0)`.mapWith(Number) })
          .from(entities)
          .where(
            and(
              eq(entities.userId, userId),
              sql`${entities.purgedAt} < now() - interval '180 days'`,
            ),
          );
        if ((!full && cursor < (expired?.floor ?? 0)) || cursor > watermark)
          throw new DomainError(
            'RESYNC_REQUIRED',
            'Refresh this device’s saved data before syncing changes.',
            410,
          );
        const page = await changedEntities(tx, userId, cursor, full);
        return {
          changes: await recordsFor(tx, userId, page.ids),
          tombstones: page.tombstones,
          nextCursor: page.hasMore ? page.nextCursor : watermark,
          hasMore: page.hasMore,
        };
      },
      true,
    );
  }
  return { execute, pull };
}
