import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { and, eq } from 'drizzle-orm';
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
import { changedEntities, inboxFor, nextVersion, recordsFor, taskFor } from './capture.repository';
import { DomainError } from './errors';

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
  if (input.type === 'note')
    await tx.insert(notes).values({
      ...std,
      title: input.text.split('\n')[0]!.slice(0, 120),
      contentText: input.text,
      contentJson: {
        type: 'doc',
        content: input.text.split('\n').map((text) => ({
          type: 'paragraph',
          ...(text ? { content: [{ type: 'text', text }] } : {}),
        })),
      },
    });
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
