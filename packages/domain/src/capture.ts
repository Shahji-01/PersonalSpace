import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  entities,
  syncState,
  tasks,
  notes,
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

// Plain text maps to a ProseMirror-compatible document. Title is the first line, matching
// how notes are first created so edits round-trip the same way through the record contract.
function noteContent(text: string) {
  return {
    title: text.split('\n')[0]!.slice(0, 120),
    contentText: text,
    contentJson: {
      type: 'doc',
      content: text.split('\n').map((line) => ({
        type: 'paragraph',
        ...(line ? { content: [{ type: 'text', text: line }] } : {}),
      })),
    },
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
    await tx.insert(tasks).values({ ...std, title: input.text, plannedDate: input.plannedDate });
  if (input.type === 'note') await tx.insert(notes).values({ ...std, ...noteContent(input.text) });
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
      } else if (command.op === 'note.edit') {
        const note = await noteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not found.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
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
        // Purge is only offered for trashed notes, so every device has already recorded the
        // deletion before the row is removed. Inbound foreign keys are RESTRICT, so clear the
        // provenance link and any converted-from reference before deleting the entity, whose
        // ON DELETE CASCADE then removes the note row.
        const note = await trashedNoteFor(tx, userId, command.id);
        if (!note) throw new DomainError('NOTE_NOT_FOUND', 'This note was not in Trash.', 404);
        if (note.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This note changed on another device. Refresh and try again.',
          );
        await tx
          .update(inboxItems)
          .set({ convertedEntityId: null })
          .where(and(eq(inboxItems.userId, userId), eq(inboxItems.convertedEntityId, note.id)));
        await tx
          .delete(entityLinks)
          .where(
            and(
              eq(entityLinks.userId, userId),
              or(eq(entityLinks.sourceId, note.id), eq(entityLinks.targetId, note.id)),
            ),
          );
        await tx.delete(entities).where(and(eq(entities.id, note.id), eq(entities.userId, userId)));
        ids = [note.id];
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
        // Permanent delete of a trashed task and its subtasks. Subtask entities are removed
        // first (cascading their task rows); inbound provenance keys on the parent are cleared
        // before its entity is deleted, matching note purge.
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
        if (subIds.length)
          await tx
            .delete(entities)
            .where(and(eq(entities.userId, userId), inArray(entities.id, subIds)));
        await tx
          .update(inboxItems)
          .set({ convertedEntityId: null })
          .where(and(eq(inboxItems.userId, userId), eq(inboxItems.convertedEntityId, task.id)));
        await tx
          .delete(entityLinks)
          .where(
            and(
              eq(entityLinks.userId, userId),
              or(eq(entityLinks.sourceId, task.id), eq(entityLinks.targetId, task.id)),
            ),
          );
        await tx.delete(entities).where(and(eq(entities.id, task.id), eq(entities.userId, userId)));
        ids = [task.id, ...subIds];
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
        // A dismissed capture is never converted, so no provenance links reference it; deleting
        // the entity cascades the inbox row.
        const item = await trashedInboxFor(tx, userId, command.id);
        if (!item)
          throw new DomainError('INBOX_NOT_FOUND', 'This inbox item was not in Trash.', 404);
        if (item.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This item changed on another device. Refresh and try again.',
          );
        await tx.delete(entities).where(and(eq(entities.id, item.id), eq(entities.userId, userId)));
        ids = [item.id];
      } else {
        const task = await taskFor(tx, userId, command.id);
        if (!task) throw new DomainError('TASK_NOT_FOUND', 'This task was not found.', 404);
        if (task.version !== command.baseVersion)
          throw new DomainError(
            'VERSION_CONFLICT',
            'This task changed on another device. Refresh and try again.',
          );
        const done = command.op === 'task.complete';
        await tx
          .update(tasks)
          .set({
            status: done ? 'done' : 'todo',
            completedAt: done ? new Date() : null,
            version,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        ids = [task.id];
      }
      for (const id of ids) {
        await tx
          .update(entities)
          .set({ version, updatedAt: new Date() })
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
      await tx
        .insert(idempotencyKeys)
        .values({ userId, key, requestHash: hash, response: records });
      return records;
    });
  }
  async function pull(userId: string, cursor: number) {
    return withUser(
      db,
      userId,
      async (tx) => {
        const page = await changedEntities(tx, userId, cursor);
        return {
          changes: await recordsFor(tx, userId, page.ids),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      },
      true,
    );
  }
  return { execute, pull };
}
