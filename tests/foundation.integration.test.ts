import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import { v7 } from 'uuid';
import { Pool } from 'pg';
import {
  createDatabase,
  withUser,
  tasks,
  notes,
  entities,
  inboxItems,
  auditLogs,
  outboxEvents,
  entityLinks,
  idempotencyKeys,
} from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import { createApp } from '../apps/api/src/app';
import { createCaptureService } from '../packages/domain/src/index';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../packages/config/src/index';
import { readDocument, documentText } from '../packages/editor-schema/src/index';

let container: StartedPostgreSqlContainer;
let owner: Pool;
let domain: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createDatabase>;
let app: FastifyInstance;
let tokenA: string;
let tokenB: string;
let userA: string;
let userB: string;
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  origin: 'personalspace://',
});
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  owner = new Pool({ connectionString: url });
  await owner.query(await readFile(new URL('../infra/postgres/init.sql', import.meta.url), 'utf8'));
  await migrate(url);
  await migrate(url); // Forward-only runner is safe to repeat.
  const appUrl = new URL(url);
  appUrl.username = 'personalspace_app';
  appUrl.password = 'local_app_only';
  const authUrl = new URL(url);
  authUrl.username = 'personalspace_auth';
  authUrl.password = 'local_auth_only';
  domain = createDatabase(appUrl.href);
  auth = createDatabase(authUrl.href);
  const config: ServerConfig = {
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '127.0.0.1',
    API_URL: 'http://localhost:4000',
    WEB_URL: 'http://localhost:3000',
    DATABASE_URL: appUrl.href,
    AUTH_DATABASE_URL: authUrl.href,
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters',
  };
  app = await createApp({
    config,
    db: domain.db,
    authDb: auth.db,
    logger: false,
    ready: async () => {
      await domain.pool.query('select 1');
    },
  });
  await app.ready();
  async function signup(email: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: {
        name: 'Test User',
        email,
        password: 'a-test-password-123',
        ageConfirmed: true,
        termsAccepted: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string; user: { id: string } }>();
  }
  const a = await signup('a@example.test');
  const b = await signup('b@example.test');
  tokenA = a.token;
  userA = a.user.id;
  tokenB = b.token;
  userB = b.user.id;
});
afterAll(async () => {
  await app?.close();
  await Promise.all([domain?.pool.end(), auth?.pool.end(), owner?.end()]);
  await container?.stop();
});

describe('authenticated capture → PostgreSQL → sync', () => {
  it('round-trips formatted notes through commands, storage, retry and sync without flattening', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [created] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id, type: 'note', text: 'Original', plannedDate: null },
      },
      'rich-text',
    );
    const document = readDocument({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'A clearer day' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'नमस्ते', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read a chapter' }] }],
            },
          ],
        },
      ],
    });
    const command = {
      op: 'note.updateContent' as const,
      id,
      contentJson: document,
      contentSchemaVersion: 1 as const,
      baseVersion: created!.version,
    };
    const key = v7();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { ...headers(tokenA), 'idempotency-key': key },
      payload: command,
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = await service.execute(userA, key, command, 'rich-text');
    expect(updated[0]?.contentJson).toEqual(document);
    expect(updated[0]?.text).toBe(documentText(document));
    expect(updated[0]?.contentSchemaVersion).toBe(1);
    const pull = await service.pull(userA, created!.version);
    expect(pull.changes.find((record) => record.id === id)?.contentJson).toEqual(document);
    await withUser(domain.db, userA, async (tx) => {
      const [row] = await tx.select().from(notes).where(eq(notes.id, id));
      expect(row?.title).toBe('A clearer day');
      expect(row?.contentJson).toEqual(document);
    });
    await expect(service.execute(userB, v7(), command, 'rich-text')).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    await expect(service.execute(userA, v7(), command, 'rich-text')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'note.edit', id, text: 'Flattened', baseVersion: updated[0]!.version },
        'rich-text',
      ),
    ).rejects.toMatchObject({ code: 'RICH_TEXT_REQUIRED' });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { ...headers(tokenA), 'idempotency-key': v7() },
      payload: {
        ...command,
        contentJson: { type: 'doc', content: [{ type: 'script', text: 'bad' }] },
      },
    });
    expect(malformed.statusCode).toBe(400);
    // Keep the pre-existing suite's initial-isolation assumptions intact.
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: updated[0]!.version },
      'rich-text',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id, baseVersion: trashed!.version },
      'rich-text',
    );
  });
  it('enforces origin checks even in tests and rejects untrusted browser sign-in', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: 'https://untrusted.example', 'sec-fetch-mode': 'cors' },
      payload: { email: 'a@example.test', password: 'a-test-password-123' },
    });
    expect(response.statusCode).toBe(403);
  });
  it('requires authentication and checks age/consent on direct signup calls', async () => {
    expect((await app.inject('/api/v1/sync/pull')).statusCode).toBe(401);
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Underage',
        email: 'c@example.test',
        password: 'a-test-password-123',
        ageConfirmed: false,
        termsAccepted: true,
      },
    });
    expect(result.statusCode).toBe(400);
  });
  it('rejects client-supplied ownership', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { ...headers(tokenA), 'idempotency-key': v7() },
      payload: {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Private task', userId: userB },
      },
    });
    expect(result.statusCode).toBe(400);
  });
  it('commits capture, audit, and outbox atomically and replays identical retries', async () => {
    const id = v7();
    const key = v7();
    const payload = {
      op: 'capture',
      payload: { id, type: 'task', text: 'Private task', plannedDate: '2026-09-29' },
    };
    const request = {
      method: 'POST' as const,
      url: '/api/v1/commands',
      headers: { ...headers(tokenA), 'idempotency-key': key },
      payload,
    };
    const first = await app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await app.inject(request);
    expect(replay.json()).toEqual(first.json());
    await withUser(domain.db, userA, async (tx) => {
      expect(await tx.select().from(tasks).where(eq(tasks.id, id))).toHaveLength(1);
      expect(await tx.select().from(auditLogs).where(eq(auditLogs.entityId, id))).toHaveLength(1);
      expect(
        (await tx.select().from(outboxEvents)).some((row) =>
          JSON.stringify(row.payload).includes(id),
        ),
      ).toBe(true);
    });
    const reuse = await app.inject({
      ...request,
      payload: { ...payload, payload: { ...payload.payload, text: 'Changed payload' } },
    });
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('RLS blocks other users even without a repository ownership predicate', async () => {
    expect(await domain.db.select().from(tasks)).toEqual([]);
    const aTasks = await withUser(domain.db, userA, (tx) => tx.select().from(tasks));
    expect(aTasks.length).toBeGreaterThan(0);
    expect(await withUser(domain.db, userB, (tx) => tx.select().from(tasks))).toEqual([]);
    const id = aTasks[0]!.id;
    await expect(
      withUser(domain.db, userB, (tx) =>
        tx.insert(tasks).values({ id: v7(), userId: userA, version: 1, title: 'unauthorized' }),
      ),
    ).rejects.toThrow();
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { ...headers(tokenB), 'idempotency-key': v7() },
      payload: { op: 'task.complete', id, baseVersion: aTasks[0]!.version },
    });
    expect(attempt.statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/sync/pull', headers: headers(tokenB) })).json().changes,
    ).toEqual([]);
    await expect(domain.pool.query('SELECT * FROM auth_session')).rejects.toThrow();
    await expect(auth.pool.query('SELECT * FROM tasks')).rejects.toThrow();
  });
  it('converts once, preserves provenance, and keeps both records on one sync page', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [inbox] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id, type: 'inbox', text: 'Read the chapter', plannedDate: null },
      },
      'test',
    );
    const targetId = v7();
    const converted = await service.execute(
      userA,
      v7(),
      { op: 'inbox.convert', id, targetId, targetType: 'task', baseVersion: inbox!.version },
      'test',
    );
    expect(converted).toHaveLength(2);
    expect(converted[0]!.version).toBe(converted[1]!.version);
    const page = await service.pull(userA, inbox!.version);
    expect(page.changes.map((r) => r.id)).toEqual(expect.arrayContaining([id, targetId]));
    expect(
      await withUser(domain.db, userA, (tx) =>
        tx.select().from(entityLinks).where(eq(entityLinks.sourceId, targetId)),
      ),
    ).toHaveLength(1);
    await expect(
      service.execute(
        userA,
        v7(),
        {
          op: 'inbox.convert',
          id,
          targetId: v7(),
          targetType: 'note',
          baseVersion: inbox!.version,
        },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_CONVERTED' });
  });
  it('edits, trashes, restores, and permanently purges a note through sync', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [created] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'note', text: 'First draft', plannedDate: null } },
      'test',
    );
    const [edited] = await service.execute(
      userA,
      v7(),
      { op: 'note.edit', id, text: 'Revised body\nSecond line', baseVersion: created!.version },
      'test',
    );
    expect(edited!.text).toBe('Revised body\nSecond line');
    expect(edited!.version).toBeGreaterThan(created!.version);
    await expect(
      service.execute(userA, v7(), { op: 'note.edit', id, text: 'stale', baseVersion: 0 }, 'test'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: edited!.version },
      'test',
    );
    expect(trashed!.deletedAt).not.toBeNull();
    const trashedPage = await service.pull(userA, edited!.version);
    expect(trashedPage.changes.find((r) => r.id === id)?.deletedAt).not.toBeNull();

    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'note.restore', id, baseVersion: trashed!.version },
      'test',
    );
    expect(restored!.deletedAt).toBeNull();

    // Convert an inbox item to a note so purge must also clear provenance FKs.
    const inboxId = v7();
    const [inbox] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: inboxId, type: 'inbox', text: 'Convert me', plannedDate: null },
      },
      'test',
    );
    const noteId = v7();
    const converted = await service.execute(
      userA,
      v7(),
      {
        op: 'inbox.convert',
        id: inboxId,
        targetId: noteId,
        targetType: 'note',
        baseVersion: inbox!.version,
      },
      'test',
    );
    const convertedNote = converted.find((r) => r.id === noteId)!;
    const [convTrashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: noteId, baseVersion: convertedNote.version },
      'test',
    );
    await expect(
      service.execute(userA, v7(), { op: 'note.purge', id: noteId, baseVersion: 0 }, 'test'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const purged = await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: noteId, baseVersion: convTrashed!.version },
      'test',
    );
    expect(purged).toEqual([]);
    await withUser(domain.db, userA, async (tx) => {
      expect(await tx.select().from(notes).where(eq(notes.id, noteId))).toHaveLength(0);
      expect(await tx.select().from(entities).where(eq(entities.id, noteId))).toHaveLength(0);
      expect(
        await tx.select().from(entityLinks).where(eq(entityLinks.sourceId, noteId)),
      ).toHaveLength(0);
      const [item] = await tx.select().from(inboxItems).where(eq(inboxItems.id, inboxId));
      expect(item?.convertedEntityId).toBeNull();
    });
  });
  it('reschedules a task and manages one level of subtasks', async () => {
    const service = createCaptureService(domain.db);
    const parentId = v7();
    const [parent] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: parentId, type: 'task', text: 'Plan trip', plannedDate: null },
      },
      'test',
    );
    const [rescheduled] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.reschedule',
        id: parentId,
        plannedDate: '2026-10-05',
        baseVersion: parent!.version,
      },
      'test',
    );
    expect(rescheduled!.plannedDate).toBe('2026-10-05');
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.reschedule', id: parentId, plannedDate: null, baseVersion: 0 },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const subId = v7();
    const [subtask] = await service.execute(
      userA,
      v7(),
      { op: 'task.addSubtask', id: subId, parentId, text: 'Book flights' },
      'test',
    );
    expect(subtask!.parentId).toBe(parentId);
    expect(subtask!.plannedDate).toBeNull();
    // A subtask cannot itself have children.
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.addSubtask', id: v7(), parentId: subId, text: 'Too deep' },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'SUBTASK_NESTING' });

    const [completedSub] = await service.execute(
      userA,
      v7(),
      { op: 'task.complete', id: subId, baseVersion: subtask!.version },
      'test',
    );
    expect(completedSub!.status).toBe('done');
    await withUser(domain.db, userA, async (tx) => {
      const children = await tx.select().from(tasks).where(eq(tasks.parentId, parentId));
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe(subId);
    });
  });
  it('renames, trashes with subtask cascade, restores, and purges a task', async () => {
    const service = createCaptureService(domain.db);
    const parentId = v7();
    const [parent] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: parentId, type: 'task', text: 'Prep launch', plannedDate: null },
      },
      'test',
    );
    const subId = v7();
    const [subtask] = await service.execute(
      userA,
      v7(),
      { op: 'task.addSubtask', id: subId, parentId, text: 'Draft copy' },
      'test',
    );
    const [renamed] = await service.execute(
      userA,
      v7(),
      { op: 'task.rename', id: parentId, text: 'Prep the launch', baseVersion: parent!.version },
      'test',
    );
    expect(renamed!.text).toBe('Prep the launch');

    // Trashing the parent cascades to the active subtask on one shared version.
    const trashed = await service.execute(
      userA,
      v7(),
      { op: 'task.delete', id: parentId, baseVersion: renamed!.version },
      'test',
    );
    expect(trashed).toHaveLength(2);
    expect(trashed.every((r) => r.deletedAt !== null)).toBe(true);
    const trashedParent = trashed.find((r) => r.id === parentId)!;

    const restored = await service.execute(
      userA,
      v7(),
      { op: 'task.restore', id: parentId, baseVersion: trashedParent.version },
      'test',
    );
    expect(restored).toHaveLength(2);
    expect(restored.every((r) => r.deletedAt === null)).toBe(true);
    const restoredParent = restored.find((r) => r.id === parentId)!;

    // Purge requires the task to be in Trash first.
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.purge', id: parentId, baseVersion: restoredParent.version },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const reTrashed = await service.execute(
      userA,
      v7(),
      { op: 'task.delete', id: parentId, baseVersion: restoredParent.version },
      'test',
    );
    const purged = await service.execute(
      userA,
      v7(),
      {
        op: 'task.purge',
        id: parentId,
        baseVersion: reTrashed.find((r) => r.id === parentId)!.version,
      },
      'test',
    );
    expect(purged).toEqual([]);
    await withUser(domain.db, userA, async (tx) => {
      expect(await tx.select().from(tasks).where(eq(tasks.parentId, parentId))).toHaveLength(0);
      expect(await tx.select().from(entities).where(eq(entities.id, parentId))).toHaveLength(0);
      expect(await tx.select().from(entities).where(eq(entities.id, subId))).toHaveLength(0);
    });
    expect(subtask!.parentId).toBe(parentId);
  });
  it('sets normalized tags on an item and keeps versions in step', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [note] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'note', text: 'Tagged thought', plannedDate: null } },
      'test',
    );
    expect(note!.tags).toEqual([]);
    const [tagged] = await service.execute(
      userA,
      v7(),
      { op: 'item.setTags', id, tags: ['Work', 'work', 'ideas'], baseVersion: note!.version },
      'test',
    );
    expect(tagged!.tags).toEqual(['work', 'ideas']);
    expect(tagged!.version).toBeGreaterThan(note!.version);
    // The record version tracks the entity version, so a second edit uses the returned version.
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'item.setTags', id, tags: ['stale'], baseVersion: note!.version },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [cleared] = await service.execute(
      userA,
      v7(),
      { op: 'item.setTags', id, tags: [], baseVersion: tagged!.version },
      'test',
    );
    expect(cleared!.tags).toEqual([]);
    const page = await service.pull(userA, note!.version - 1);
    expect(page.changes.find((r) => r.id === id)?.tags).toEqual([]);
  });
  it('dismisses, restores, and purges an inbox capture but not a converted one', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [item] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'inbox', text: 'Maybe later', plannedDate: null } },
      'test',
    );
    const [dismissed] = await service.execute(
      userA,
      v7(),
      { op: 'inbox.delete', id, baseVersion: item!.version },
      'test',
    );
    expect(dismissed!.deletedAt).not.toBeNull();
    const page = await service.pull(userA, item!.version);
    expect(page.changes.find((r) => r.id === id)?.deletedAt).not.toBeNull();
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'inbox.restore', id, baseVersion: dismissed!.version },
      'test',
    );
    expect(restored!.deletedAt).toBeNull();

    // A converted capture cannot be dismissed.
    const noteId = v7();
    const converted = await service.execute(
      userA,
      v7(),
      {
        op: 'inbox.convert',
        id,
        targetId: noteId,
        targetType: 'note',
        baseVersion: restored!.version,
      },
      'test',
    );
    const filedInbox = converted.find((r) => r.id === id)!;
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'inbox.delete', id, baseVersion: filedInbox.version },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_CONVERTED' });

    // A fresh, unfiled capture can be dismissed and then purged for good.
    const gone = v7();
    const [fresh] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: gone, type: 'inbox', text: 'Discard me', plannedDate: null },
      },
      'test',
    );
    const [freshTrashed] = await service.execute(
      userA,
      v7(),
      { op: 'inbox.delete', id: gone, baseVersion: fresh!.version },
      'test',
    );
    const purged = await service.execute(
      userA,
      v7(),
      { op: 'inbox.purge', id: gone, baseVersion: freshTrashed!.version },
      'test',
    );
    expect(purged).toEqual([]);
    await withUser(domain.db, userA, async (tx) => {
      expect(await tx.select().from(inboxItems).where(eq(inboxItems.id, gone))).toHaveLength(0);
      expect(await tx.select().from(entities).where(eq(entities.id, gone))).toHaveLength(0);
    });
  });
  it('sets task priority and a deadline separate from the planned date', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id, type: 'task', text: 'Ship release', plannedDate: '2026-10-01' },
      },
      'test',
    );
    expect(task!.priority).toBe(0);
    expect(task!.dueDate).toBeNull();
    const [prioritized] = await service.execute(
      userA,
      v7(),
      { op: 'task.setPriority', id, priority: 3, baseVersion: task!.version },
      'test',
    );
    expect(prioritized!.priority).toBe(3);
    const [dated] = await service.execute(
      userA,
      v7(),
      { op: 'task.setDueDate', id, dueDate: '2026-10-05', baseVersion: prioritized!.version },
      'test',
    );
    expect(dated!.dueDate).toBe('2026-10-05');
    expect(dated!.plannedDate).toBe('2026-10-01'); // deadline is independent of the do-date
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.setPriority', id, priority: 1, baseVersion: task!.version },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('pins, favorites, and archives a note with independent flags', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [note] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'note', text: 'Keeper', plannedDate: null } },
      'test',
    );
    expect(note!.pinned).toBe(false);
    expect(note!.favorite).toBe(false);
    expect(note!.archivedAt).toBeNull();
    const [pinned] = await service.execute(
      userA,
      v7(),
      { op: 'note.setPinned', id, pinned: true, baseVersion: note!.version },
      'test',
    );
    expect(pinned!.pinned).toBe(true);
    const [favorited] = await service.execute(
      userA,
      v7(),
      { op: 'note.setFavorite', id, favorite: true, baseVersion: pinned!.version },
      'test',
    );
    expect(favorited!.favorite).toBe(true);
    expect(favorited!.pinned).toBe(true); // flags are independent
    const [archived] = await service.execute(
      userA,
      v7(),
      { op: 'note.setArchived', id, archived: true, baseVersion: favorited!.version },
      'test',
    );
    expect(archived!.archivedAt).not.toBeNull();
    const page = await service.pull(userA, note!.version);
    expect(page.changes.find((r) => r.id === id)?.archivedAt).not.toBeNull();
    const [unarchived] = await service.execute(
      userA,
      v7(),
      { op: 'note.setArchived', id, archived: false, baseVersion: archived!.version },
      'test',
    );
    expect(unarchived!.archivedAt).toBeNull();
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'note.setPinned', id, pinned: false, baseVersion: note!.version },
        'test',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('serializes concurrent duplicate mutations and rejects stale task updates', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const key = v7();
    const command = {
      op: 'capture' as const,
      payload: { id, type: 'task' as const, text: 'Concurrent', plannedDate: null },
    };
    const results = await Promise.all([
      service.execute(userA, key, command, 'one'),
      service.execute(userA, key, command, 'two'),
    ]);
    expect(results[0]).toEqual(results[1]);
    const version = results[0]![0]!.version;
    await service.execute(userA, v7(), { op: 'task.complete', id, baseVersion: version }, 'three');
    await expect(
      service.execute(userA, v7(), { op: 'task.reopen', id, baseVersion: version }, 'four'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('rolls back rejected writes and prevents audit modification', async () => {
    const service = createCaptureService(domain.db);
    const key = v7();
    await expect(
      service.execute(userA, key, { op: 'task.complete', id: v7(), baseVersion: 0 }, 'rollback'),
    ).rejects.toThrow();
    expect(
      await withUser(domain.db, userA, (tx) =>
        tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)),
      ),
    ).toEqual([]);
    await expect(
      withUser(domain.db, userA, (tx) => tx.execute(sql`delete from audit_logs`)),
    ).rejects.toThrow();
  });
  it('signs in with a password and revokes the session on sign-out', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: { email: 'a@example.test', password: 'a-test-password-123' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const token = response.json<{ token: string }>().token;
    expect((await app.inject({ url: '/api/v1/me', headers: headers(token) })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: headers(token),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/v1/me', headers: headers(token) })).statusCode).toBe(401);
  });
  it('fails closed for every product table and does not leak pooled user context', async () => {
    const tables = [
      'user_sync_state',
      'entities',
      'inbox_items',
      'tasks',
      'notes',
      'entity_links',
      'idempotency_keys',
      'outbox_events',
      'audit_logs',
    ];
    const client = await domain.pool.connect();
    try {
      for (const table of tables) {
        expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      }
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userB]);
      for (const table of tables) {
        const result = await client.query<{ user_id: string }>(`SELECT user_id FROM ${table}`);
        expect(result.rows.every((row) => row.user_id === userB)).toBe(true);
      }
      await client.query('COMMIT');
      for (const table of tables)
        expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});
