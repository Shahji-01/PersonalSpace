import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile, readdir } from 'node:fs/promises';
import { v7 } from 'uuid';
import { Pool } from 'pg';
import {
  createDatabase,
  withUser,
  tasks,
  notes,
  noteVersions,
  noteFolders,
  projects,
  recurrenceRules,
  entities,
  inboxItems,
  auditLogs,
  outboxEvents,
  entityLinks,
  idempotencyKeys,
} from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import { createApp } from '../apps/api/src/app';
import {
  createCaptureService,
  createNoteHistoryService,
  createSearchService,
  reconcileBalances,
  cleanupTrash,
  cleanupTombstones,
  cleanupIdempotencyKeys,
  expireExports,
  deliverDueReminders,
  processPendingEmails,
  generateExportData,
  exportToJson,
  processPendingMetadata,
  executePendingDeletions,
  requestDeletion,
  cancelDeletion,
} from '../packages/domain/src/index';
import { searchQuerySchema, type RecordItem } from '../packages/validation/src/index';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../packages/config/src/index';
import { readDocument, documentText, plainTextDocument } from '../packages/editor-schema/src/index';

let container: StartedPostgreSqlContainer;
let owner: Pool;
let domain: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createDatabase>;
// Maintenance jobs run cross-user; mirror that with a privileged connection.
let maintenance: ReturnType<typeof createDatabase>;
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
  const maintUrl = new URL(url);
  maintUrl.username = 'personalspace_maintenance';
  maintUrl.password = 'local_maintenance_only';
  maintenance = createDatabase(maintUrl.href);
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
  await Promise.all([domain?.pool.end(), auth?.pool.end(), maintenance?.pool.end(), owner?.end()]);
  await container?.stop();
});

describe('authenticated capture → PostgreSQL → sync', () => {
  it('recovers a rich stale draft as an idempotent linked note without overwriting its source', async () => {
    const service = createCaptureService(domain.db);
    const [source] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Original note', plannedDate: null },
      },
      'copy',
    );
    const [updated] = await service.execute(
      userA,
      v7(),
      {
        op: 'note.updateContent',
        id: source!.id,
        contentJson: plainTextDocument('Newer server version'),
        contentSchemaVersion: 1,
        baseVersion: source!.version,
      },
      'copy',
    );
    const content = readDocument({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Unfinished draft', marks: [{ type: 'bold' }] },
            { type: 'noteReference', attrs: { noteId: source!.id } },
          ],
        },
      ],
    });
    const key = v7();
    const command = {
      op: 'note.copyDraft' as const,
      id: v7(),
      sourceId: source!.id,
      sourceBaseVersion: source!.version,
      contentJson: content,
      contentSchemaVersion: 1 as const,
    };
    const [copy] = await service.execute(userA, key, command, 'copy');
    expect(copy).toMatchObject({
      recoveredFromId: source!.id,
      contentJson: content,
      kind: 'note',
      dailyDate: null,
    });
    expect(await service.execute(userA, key, command, 'retry')).toEqual([copy]);
    const page = await service.pull(userA, 0);
    expect(page.changes.find((r) => r.id === source!.id)).toEqual(updated);
    expect((await createNoteHistoryService(domain.db).list(userA, copy!.id)).versions).toHaveLength(
      1,
    );
    await expect(
      service.execute(userB, v7(), { ...command, id: v7() }, 'foreign'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await expect(
      service.execute(
        userA,
        v7(),
        { ...command, id: v7(), sourceBaseVersion: updated!.version + 100 },
        'future',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [foreign] = await service.execute(
      userB,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Foreign recovery fixture', plannedDate: null },
      },
      'copy',
    );
    await expect(
      withUser(domain.db, userB, (tx) =>
        tx.update(notes).set({ recoveredFromId: source!.id }).where(eq(notes.id, foreign!.id)),
      ),
    ).rejects.toThrow();
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: source!.id, baseVersion: updated!.version },
      'copy',
    );
    await expect(
      service.execute(userA, v7(), { ...command, id: v7() }, 'trashed'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: source!.id, baseVersion: trashed!.version },
      'copy',
    );
    const remaining = await service.pull(userA, 0);
    expect(remaining.changes.find((r) => r.id === copy!.id)?.contentJson).toEqual(content);
    await expect(
      service.execute(userA, v7(), { ...command, id: v7() }, 'purged'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
  });
  it('requires recovery for expired deletion cursors, returns all markers in full mode and isolates accounts', async () => {
    const service = createCaptureService(domain.db);
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Expired purge fixture', plannedDate: null },
      },
      'retention',
    );
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: note!.id, baseVersion: note!.version },
      'retention',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: note!.id, baseVersion: trashed!.version },
      'retention',
    );
    const before = await service.pull(userA, 0);
    const marker = before.tombstones.find((t) => t.id === note!.id)!;
    expect(marker).toBeDefined();
    await owner.query("UPDATE entities SET purged_at=now()-interval '181 days' WHERE id=$1", [
      note!.id,
    ]);
    try {
      const stale = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/pull?cursor=${note!.version}`,
        headers: headers(tokenA),
      });
      expect(stale.statusCode).toBe(410);
      expect(stale.json().error.code).toBe('RESYNC_REQUIRED');
      const full = await app.inject({
        method: 'GET',
        url: '/api/v1/sync/pull?cursor=0&mode=full',
        headers: headers(tokenA),
      });
      expect(full.statusCode).toBe(200);
      expect(full.json().tombstones.some((t: { id: string }) => t.id === note!.id)).toBe(true);
      expect((await service.pull(userA, marker.version)).tombstones).toEqual([]);
      const other = await service.pull(userB, 0);
      expect(other.tombstones.some((t) => t.id === note!.id)).toBe(false);
      await expect(service.pull(userA, before.nextCursor + 100000)).rejects.toMatchObject({
        code: 'RESYNC_REQUIRED',
      });
      const [created] = await service.execute(
        userA,
        v7(),
        {
          op: 'capture',
          payload: { id: v7(), type: 'task', text: 'Created during recovery', plannedDate: null },
        },
        'retention',
      );
      expect(
        (await service.pull(userA, marker.version, true)).changes.some((r) => r.id === created!.id),
      ).toBe(true);
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/v1/sync/pull?mode=anything',
        headers: headers(tokenA),
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      // Other cases intentionally request cursor zero through the incremental API.
      await owner.query('UPDATE entities SET purged_at=now() WHERE id=$1', [note!.id]);
    }
  });
  it('cascades synthetic account deletion through recurrence rules and successor links', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: {
        name: 'Recurrence cleanup fixture',
        email: `recurrence-${v7()}@example.test`,
        password: 'a-test-password-123',
        ageConfirmed: true,
        termsAccepted: true,
      },
    });
    expect(signup.statusCode).toBe(200);
    const id = signup.json<{ user: { id: string } }>().user.id;
    const service = createCaptureService(domain.db);
    const [task] = await service.execute(
      id,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Cleanup fixture', plannedDate: '2026-01-01' },
      },
      'cleanup',
    );
    const [repeating] = await service.execute(
      id,
      v7(),
      {
        op: 'task.setRecurrence',
        id: task!.id,
        baseVersion: task!.version,
        recurrence: {
          frequency: 'DAILY',
          interval: 1,
          weekdays: [],
          lastDay: false,
          mode: 'fixed_schedule',
          anchorDate: '2026-01-01',
          anchorTime: null,
          timeMode: 'floating',
          timezone: 'UTC',
          endsOn: null,
          count: 2,
        },
      },
      'cleanup',
    );
    const advanced = await service.execute(
      id,
      v7(),
      { op: 'task.complete', id: task!.id, baseVersion: repeating!.version },
      'cleanup',
    );
    expect(advanced).toHaveLength(2);
    await owner.query('DELETE FROM auth_user WHERE id=$1', [id]);
    for (const table of [
      'entities',
      'tasks',
      'recurrence_rules',
      'search_documents',
      'idempotency_keys',
    ]) {
      const remaining = await owner.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE user_id=$1`,
        [id],
      );
      expect(remaining.rows[0].count).toBe(0);
    }
  });
  it('creates, orders, archives projects and moves a task family with ownership and version checks', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const key = v7();
    const create = { op: 'project.create' as const, id, name: 'Build something', color: '#275D48' };
    const [first] = await service.execute(userA, key, create, 'projects');
    expect(await service.execute(userA, key, create, 'retry')).toEqual([first]);
    expect(first).toMatchObject({
      type: 'project',
      status: 'active',
      color: '#275D48',
      sortOrder: 0,
    });
    const [second] = await service.execute(
      userA,
      v7(),
      { ...create, id: v7(), name: 'Learn something' },
      'projects',
    );
    const [third] = await service.execute(
      userA,
      v7(),
      { ...create, id: v7(), name: 'Personal' },
      'projects',
    );
    const moveKey = v7();
    const move = {
      op: 'project.move' as const,
      id: third!.id,
      beforeId: id,
      baseVersion: third!.version,
    };
    const reordered = await service.execute(userA, moveKey, move, 'projects');
    expect(
      reordered.map((p) => [p.id, p.sortOrder]).sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [third!.id, 0],
      [id, 1],
      [second!.id, 2],
    ]);
    expect(new Set(reordered.map((p) => p.version)).size).toBe(1);
    expect(await service.execute(userA, moveKey, move, 'retry')).toEqual(reordered);
    const currentFirst = reordered.find((p) => p.id === id)!;
    const [updated] = await service.execute(
      userA,
      v7(),
      {
        op: 'project.update',
        id,
        name: 'Ship it',
        color: '#3563A5',
        baseVersion: currentFirst.version,
      },
      'projects',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'project.update', id, name: 'Stale', color: '#3563A5', baseVersion: first!.version },
        'projects',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [parent] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'First milestone', plannedDate: null },
      },
      'projects',
    );
    const [child] = await service.execute(
      userA,
      v7(),
      { op: 'task.addSubtask', id: v7(), parentId: parent!.id, text: 'Small step' },
      'projects',
    );
    const assigned = await service.execute(
      userA,
      v7(),
      { op: 'task.setProject', id: parent!.id, projectId: id, baseVersion: parent!.version },
      'projects',
    );
    expect(assigned).toHaveLength(2);
    expect(assigned.every((t) => t.projectId === id)).toBe(true);
    expect(new Set(assigned.map((t) => t.version)).size).toBe(1);
    const [newChild] = await service.execute(
      userA,
      v7(),
      { op: 'task.addSubtask', id: v7(), parentId: parent!.id, text: 'Another step' },
      'projects',
    );
    expect(newChild?.projectId).toBe(id);
    await expect(
      service.execute(
        userA,
        v7(),
        {
          op: 'task.setProject',
          id: child!.id,
          projectId: null,
          baseVersion: assigned[0]!.version,
        },
        'projects',
      ),
    ).rejects.toMatchObject({ code: 'SUBTASK_PROJECT' });
    const [foreign] = await service.execute(
      userB,
      v7(),
      { ...create, id: v7(), name: 'Private project' },
      'projects',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        {
          op: 'task.setProject',
          id: parent!.id,
          projectId: foreign!.id,
          baseVersion: assigned[0]!.version,
        },
        'projects',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      withUser(domain.db, userA, (tx) =>
        tx.update(tasks).set({ projectId: foreign!.id }).where(eq(tasks.id, parent!.id)),
      ),
    ).rejects.toThrow();
    const [archived] = await service.execute(
      userA,
      v7(),
      { op: 'project.setArchived', id, archived: true, baseVersion: updated!.version },
      'projects',
    );
    expect(archived?.status).toBe('archived');
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.setProject', id: parent!.id, projectId: id, baseVersion: assigned[0]!.version },
        'projects',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    const unassigned = await service.execute(
      userA,
      v7(),
      { op: 'task.setProject', id: parent!.id, projectId: null, baseVersion: assigned[0]!.version },
      'projects',
    );
    expect(unassigned).toHaveLength(3);
    expect(unassigned.every((t) => t.projectId === null && t.status === 'todo')).toBe(true);
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'project.setArchived', id, archived: false, baseVersion: archived!.version },
      'projects',
    );
    expect(restored?.status).toBe('active');
    expect(
      (await service.pull(userA, archived!.version)).changes.some(
        (r) => r.id === id && r.status === 'active',
      ),
    ).toBe(true);
    await withUser(domain.db, userB, async (tx) =>
      expect((await tx.select().from(projects)).every((p) => p.userId === userB)).toBe(true),
    );
  });
  it('organizes notes in owner-scoped folders with depth, cycle, subtree, conflict and deletion guards', async () => {
    const service = createCaptureService(domain.db);
    const rootId = v7();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { ...headers(tokenA), 'idempotency-key': v7() },
      payload: { op: 'folder.create', id: rootId, name: ' Work ', parentId: null },
    });
    expect(response.statusCode, response.body).toBe(200);
    const root = response.json().data[0];
    expect(root).toMatchObject({ type: 'folder', text: 'Work', parentId: null });
    const [child] = await service.execute(
      userA,
      v7(),
      { op: 'folder.create', id: v7(), name: 'Projects', parentId: rootId },
      'folders',
    );
    const [leaf] = await service.execute(
      userA,
      v7(),
      { op: 'folder.create', id: v7(), name: 'Ideas', parentId: child!.id },
      'folders',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.create', id: v7(), name: 'Too deep', parentId: leaf!.id },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_DEPTH' });
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.move', id: rootId, parentId: leaf!.id, baseVersion: root.version },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_CYCLE' });
    const [otherRoot] = await service.execute(
      userA,
      v7(),
      { op: 'folder.create', id: v7(), name: 'Personal', parentId: null },
      'folders',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.move', id: rootId, parentId: otherRoot!.id, baseVersion: root.version },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_DEPTH' });
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.rename', id: rootId, name: 'Stale', baseVersion: 0 },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.delete', id: rootId, baseVersion: root.version },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NOT_EMPTY' });
    await expect(
      service.execute(
        userB,
        v7(),
        { op: 'folder.create', id: v7(), name: 'Forbidden', parentId: rootId },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    const [moved] = await service.execute(
      userA,
      v7(),
      { op: 'folder.move', id: leaf!.id, parentId: null, baseVersion: leaf!.version },
      'folders',
    );
    const [renamed] = await service.execute(
      userA,
      v7(),
      { op: 'folder.rename', id: leaf!.id, name: 'Loose ideas', baseVersion: moved!.version },
      'folders',
    );
    expect(renamed).toMatchObject({ text: 'Loose ideas', parentId: null });
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Folder note', plannedDate: null },
      },
      'folders',
    );
    const [filed] = await service.execute(
      userA,
      v7(),
      { op: 'note.setFolder', id: note!.id, folderId: leaf!.id, baseVersion: note!.version },
      'folders',
    );
    expect(filed?.folderId).toBe(leaf!.id);
    const [foreign] = await service.execute(
      userB,
      v7(),
      { op: 'folder.create', id: v7(), name: 'Private', parentId: null },
      'folders',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'note.setFolder', id: note!.id, folderId: foreign!.id, baseVersion: filed!.version },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    await expect(
      withUser(domain.db, userA, (tx) =>
        tx.update(notes).set({ folderId: foreign!.id }).where(eq(notes.id, note!.id)),
      ),
    ).rejects.toThrow();
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: note!.id, baseVersion: filed!.version },
      'folders',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.delete', id: leaf!.id, baseVersion: renamed!.version },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NOT_EMPTY' });
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'note.restore', id: note!.id, baseVersion: trashed!.version },
      'folders',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.setFolder', id: note!.id, folderId: null, baseVersion: restored!.version },
      'folders',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'folder.delete', id: leaf!.id, baseVersion: renamed!.version },
      'folders',
    );
    expect(
      (await service.pull(userA, renamed!.version)).tombstones.some((r) => r.id === leaf!.id),
    ).toBe(true);
    await withUser(domain.db, userA, async (tx) =>
      expect(await tx.select().from(noteFolders).where(eq(noteFolders.id, leaf!.id))).toEqual([]),
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'folder.create', id: leaf!.id, name: 'Reuse', parentId: null },
        'folders',
      ),
    ).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
  });
  it('upgrades existing notes and historical purges without losing content or reviving erased data', async () => {
    await owner.query('CREATE DATABASE upgrade_fixture');
    const url = new URL(container.getConnectionUri());
    url.pathname = '/upgrade_fixture';
    const upgrade = new Pool({ connectionString: url.href });
    try {
      const dir = new URL('../packages/db/migrations/', import.meta.url);
      for (const name of (await readdir(dir))
        .filter((name) => name.endsWith('.sql') && name < '0010')
        .sort())
        await upgrade.query(await readFile(new URL(name, dir), 'utf8'));
      const user = v7();
      const deleted = v7();
      const live = v7();
      const legacy = { id: deleted, text: 'Previously purged secret' };
      await upgrade.query(
        "INSERT INTO auth_user(id,name,email,age_confirmed,terms_accepted) VALUES ($1,'Upgrade','upgrade@example.test',true,true)",
        [user],
      );
      await upgrade.query('INSERT INTO user_sync_state(user_id,version) VALUES ($1,4)', [user]);
      await upgrade.query(
        "INSERT INTO audit_logs(id,user_id,entity_id,action,request_id) VALUES ($1,$2,$3,'note.purge','upgrade')",
        [v7(), user, deleted],
      );
      await upgrade.query(
        "INSERT INTO idempotency_keys(user_id,key,request_hash,response) VALUES ($1,$2,'hash',$3)",
        [user, v7(), JSON.stringify([legacy])],
      );
      await upgrade.query("INSERT INTO entities(id,user_id,type,version) VALUES ($1,$2,'note',3)", [
        live,
        user,
      ]);
      await upgrade.query(
        "INSERT INTO notes(id,user_id,version,title,content_json,content_text) VALUES ($1,$2,3,'Keep me',$3,'Keep me')",
        [
          live,
          user,
          JSON.stringify({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep me' }] }],
          }),
        ],
      );
      await upgrade.query(await readFile(new URL('0010_sync_tombstones.sql', dir), 'utf8'));
      await upgrade.query(await readFile(new URL('0011_note_versions.sql', dir), 'utf8'));
      for (const name of (await readdir(dir))
        .filter((name) => name.endsWith('.sql') && name > '0011_note_versions.sql')
        .sort())
        await upgrade.query(await readFile(new URL(name, dir), 'utf8'));
      expect((await upgrade.query('SELECT entity_id,title FROM search_documents')).rows).toEqual([
        { entity_id: live, title: 'Keep me' },
      ]);
      const marker = (
        await upgrade.query('SELECT version,purged_at,tags FROM entities WHERE id=$1', [deleted])
      ).rows[0];
      expect(Number(marker.version)).toBe(5);
      expect(marker.purged_at).toBeInstanceOf(Date);
      expect(marker.tags).toEqual([]);
      expect(
        (await upgrade.query('SELECT response FROM idempotency_keys')).rows[0].response,
      ).toEqual([]);
      expect(
        (await upgrade.query('SELECT title,version FROM note_versions WHERE note_id=$1', [live]))
          .rows,
      ).toEqual([{ title: 'Keep me', version: '3' }]);
    } finally {
      await upgrade.end();
    }
  });

  it('checkpoints drafts without publishing changes and restores them with ownership/version guards', async () => {
    const service = createCaptureService(domain.db),
      history = createNoteHistoryService(domain.db);
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Published note', plannedDate: null },
      },
      'checkpoint',
    );
    const command = {
      op: 'note.checkpoint' as const,
      id: note!.id,
      contentJson: plainTextDocument('Unfinished thought'),
      contentSchemaVersion: 1 as const,
      baseVersion: note!.version,
      reason: 'interval' as const,
    };
    const key = v7();
    expect(await service.execute(userA, key, command, 'checkpoint')).toEqual([]);
    expect(await service.execute(userA, key, command, 'retry')).toEqual([]);
    expect(
      (await service.pull(userA, note!.version - 1)).changes.find((r) => r.id === note!.id),
    ).toEqual(note);
    let snapshots = (await history.list(userA, note!.id)).versions;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ title: 'Unfinished thought', reason: 'interval' });
    await service.execute(userA, v7(), command, 'same-content');
    expect((await history.list(userA, note!.id)).versions).toHaveLength(2);
    await expect(service.execute(userB, v7(), command, 'foreign')).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
    });
    await expect(
      service.execute(userA, v7(), { ...command, baseVersion: 0 }, 'stale'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [restored] = await service.execute(
      userA,
      v7(),
      {
        op: 'note.restoreVersion',
        id: note!.id,
        versionId: snapshots[0]!.id,
        baseVersion: note!.version,
      },
      'restore-checkpoint',
    );
    expect(restored!.text).toBe('Unfinished thought');
    expect(restored!.version).toBeGreaterThan(snapshots[0]!.version);
    snapshots = (await history.list(userA, note!.id)).versions;
    expect(snapshots[0]!.reason).toBe('restore');
    const [trash] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: note!.id, baseVersion: restored!.version },
      'trash',
    );
    await expect(
      service.execute(userA, v7(), { ...command, baseVersion: trash!.version }, 'trash-checkpoint'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: note!.id, baseVersion: trash!.version },
      'purge',
    );
    await expect(history.list(userA, note!.id)).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    expect(await service.execute(userA, key, command, 'purged-retry')).toEqual([]);
  });
  it('lists isolated note history and restores a snapshot as a new synced, idempotent version', async () => {
    const service = createCaptureService(domain.db);
    const history = createNoteHistoryService(domain.db);
    const id = v7();
    const [original] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'note', text: 'First version', plannedDate: null } },
      'history',
    );
    const [edited] = await service.execute(
      userA,
      v7(),
      { op: 'note.edit', id, text: 'Second version', baseVersion: original!.version },
      'history',
    );
    const response = await app.inject({
      url: `/api/v1/notes/${id}/versions`,
      headers: headers(tokenA),
    });
    expect(response.statusCode, response.body).toBe(200);
    const before = await history.list(userA, id);
    expect(before.versions.map((r) => r.title)).toEqual(['Second version', 'First version']);
    expect(
      (await app.inject({ url: `/api/v1/notes/${id}/versions`, headers: headers(tokenB) }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: `/api/v1/notes/${id}/versions` })).statusCode).toBe(401);
    const restore = {
      op: 'note.restoreVersion' as const,
      id,
      versionId: before.versions[1]!.id,
      baseVersion: edited!.version,
    };
    const key = v7();
    const [restored] = await service.execute(userA, key, restore, 'history');
    expect(restored?.text).toBe('First version');
    expect(restored!.version).toBeGreaterThan(edited!.version);
    expect(await service.execute(userA, key, restore, 'retry')).toEqual([restored]);
    const after = await history.list(userA, id);
    expect(after.versions).toHaveLength(3);
    expect(after.versions[0]?.reason).toBe('restore');
    expect(after.versions.slice(1)).toEqual(before.versions);
    expect(
      (await service.pull(userA, edited!.version)).changes.find((r) => r.id === id)?.text,
    ).toBe('First version');
    await expect(service.execute(userA, v7(), restore, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      service.execute(
        userA,
        v7(),
        { ...restore, versionId: v7(), baseVersion: restored!.version },
        'missing',
      ),
    ).rejects.toMatchObject({ code: 'NOTE_VERSION_NOT_FOUND' });
    const otherId = v7();
    const [other] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: otherId, type: 'note', text: 'Another note', plannedDate: null },
      },
      'history',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { ...restore, id: otherId, baseVersion: other!.version },
        'wrong-note',
      ),
    ).rejects.toMatchObject({ code: 'NOTE_VERSION_NOT_FOUND' });
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: restored!.version },
      'history',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id, baseVersion: trashed!.version },
      'history',
    );
    await expect(history.list(userA, id)).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await withUser(domain.db, userA, async (tx) =>
      expect(await tx.select().from(noteVersions).where(eq(noteVersions.noteId, id))).toEqual([]),
    );
  });

  it('retains at least 50 snapshots plus every recent snapshot and paginates without overlap', async () => {
    const service = createCaptureService(domain.db);
    const history = createNoteHistoryService(domain.db);
    const id = v7();
    const [original] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'note', text: 'Recent original', plannedDate: null } },
      'retention',
    );
    // Historical fixture versions, older than 30 days; reserve their numbers before the next write.
    const fixtures = Array.from({ length: 60 }, (_, i) => ({
      id: v7(),
      version: original!.version + i + 1,
    }));
    await owner.query(
      `INSERT INTO note_versions(id,note_id,user_id,version,title,content_json,reason,created_at)
      SELECT x.id,$1,$2,x.version,'Old snapshot',n.content_json,'session_end',now()-interval '40 days'
      FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,version bigint) CROSS JOIN notes n WHERE n.id=$1`,
      [id, userA, JSON.stringify(fixtures)],
    );
    await owner.query('UPDATE user_sync_state SET version=version+100 WHERE user_id=$1', [userA]);
    await service.execute(
      userA,
      v7(),
      { op: 'note.edit', id, text: 'Latest snapshot', baseVersion: original!.version },
      'retention',
    );
    const a = await history.list(userA, id);
    const b = await history.list(userA, id, a.nextCursor!);
    const c = await history.list(userA, id, b.nextCursor!);
    const versions = [...a.versions, ...b.versions, ...c.versions];
    expect(versions).toHaveLength(51);
    expect(new Set(versions.map((r) => r.id)).size).toBe(51);
    expect(versions.at(-1)?.title).toBe('Recent original');
    expect(versions[0]?.title).toBe('Latest snapshot');
    expect(c.nextCursor).toBeNull();
    expect(versions.some((r) => r.id === fixtures[0]!.id)).toBe(false);
  });
  it('propagates permanent deletion to offline devices and erases retry content without reusing IDs', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const key = v7();
    const command = {
      op: 'capture' as const,
      payload: { id, type: 'note' as const, text: 'Erase this private content', plannedDate: null },
    };
    const [created] = await service.execute(userA, key, command, 'purge-sync');
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: created!.version },
      'purge-sync',
    );
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'item.setTags', id, tags: ['hidden'], baseVersion: trashed!.version },
        'purge-sync',
      ),
    ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    const purgeKey = v7();
    const purge = { op: 'note.purge' as const, id, baseVersion: trashed!.version };
    await service.execute(userA, purgeKey, purge, 'purge-sync');
    const response = await app.inject({
      url: `/api/v1/sync/pull?cursor=${created!.version}`,
      headers: headers(tokenA),
    });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.changes.some((r: { id: string }) => r.id === id)).toBe(false);
    expect(page.tombstones).toContainEqual({
      id,
      version: page.nextCursor,
      purgedAt: expect.any(String),
    });
    expect((await service.pull(userB, 0)).tombstones.some((r) => r.id === id)).toBe(false);
    expect(await service.execute(userA, key, command, 'old-retry')).toEqual([]);
    expect(await service.execute(userA, purgeKey, purge, 'purge-retry')).toEqual([]);
    await expect(service.execute(userA, v7(), command, 'new-key')).rejects.toMatchObject({
      code: 'ID_UNAVAILABLE',
    });
    await withUser(domain.db, userA, async (tx) => {
      const [marker] = await tx.select().from(entities).where(eq(entities.id, id));
      expect(marker?.tags).toEqual([]);
      expect(marker?.purgedAt).toBeInstanceOf(Date);
      const responses = await tx.select().from(idempotencyKeys);
      expect(JSON.stringify(responses)).not.toContain('Erase this private content');
    });
  });
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
    const bPage = (await app.inject({ url: '/api/v1/sync/pull', headers: headers(tokenB) })).json();
    const bIds = new Set(
      (
        await owner.query<{ id: string }>('SELECT id FROM entities WHERE user_id=$1', [userB])
      ).rows.map((r) => r.id),
    );
    expect(bPage.changes.every((r: { id: string }) => bIds.has(r.id))).toBe(true);
    expect(bPage.changes.some((r: { id: string }) => r.id === id)).toBe(false);
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
      expect(
        (await tx.select().from(entities).where(eq(entities.id, noteId)))[0]?.purgedAt,
      ).toBeInstanceOf(Date);
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
    const deletionPage = await service.pull(userA, reTrashed[0]!.version);
    const cascade = deletionPage.tombstones.filter((r) => [parentId, subId].includes(r.id));
    expect(cascade).toHaveLength(2);
    expect(new Set(cascade.map((r) => r.version)).size).toBe(1);
    await withUser(domain.db, userA, async (tx) => {
      expect(await tx.select().from(tasks).where(eq(tasks.parentId, parentId))).toHaveLength(0);
      expect(
        (await tx.select().from(entities).where(eq(entities.id, parentId)))[0]?.purgedAt,
      ).toBeInstanceOf(Date);
      expect(
        (await tx.select().from(entities).where(eq(entities.id, subId)))[0]?.purgedAt,
      ).toBeInstanceOf(Date);
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
      expect(
        (await tx.select().from(entities).where(eq(entities.id, gone)))[0]?.purgedAt,
      ).toBeInstanceOf(Date);
    });
  });
  it('round-trips rich task descriptions and estimates, independently archives, and enforces ownership and versions', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id, type: 'task', text: 'Prepare proposal', plannedDate: '2026-10-02' },
      },
      'task-details',
    );
    const content = readDocument({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Include pricing', marks: [{ type: 'bold' }] }],
        },
      ],
    });
    const key = v7();
    const command = {
      op: 'task.updateDescription' as const,
      id,
      baseVersion: task!.version,
      contentJson: content,
      contentSchemaVersion: 1 as const,
    };
    const [described] = await service.execute(userA, key, command, 'task-details');
    expect(described!.text).toBe('Prepare proposal');
    expect(described!.descriptionJson).toEqual(content);
    expect(await service.execute(userA, key, command, 'retry')).toEqual([described]);
    await expect(
      service.execute(userB, v7(), { ...command, baseVersion: described!.version }, 'other-user'),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(service.execute(userA, v7(), command, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const [estimated] = await service.execute(
      userA,
      v7(),
      { op: 'task.setEstimate', id, estimatedMinutes: 45, baseVersion: described!.version },
      'task-details',
    );
    const [archived] = await service.execute(
      userA,
      v7(),
      { op: 'task.setArchived', id, archived: true, baseVersion: estimated!.version },
      'task-details',
    );
    expect(archived).toMatchObject({
      status: 'todo',
      estimatedMinutes: 45,
      plannedDate: '2026-10-02',
      descriptionJson: content,
    });
    expect(archived!.archivedAt).not.toBeNull();
    expect((await service.pull(userA, estimated!.version)).changes).toContainEqual(archived);
    const [unarchived] = await service.execute(
      userA,
      v7(),
      { op: 'task.setArchived', id, archived: false, baseVersion: archived!.version },
      'task-details',
    );
    const [cleared] = await service.execute(
      userA,
      v7(),
      { op: 'task.setEstimate', id, estimatedMinutes: null, baseVersion: unarchived!.version },
      'task-details',
    );
    expect(cleared!.archivedAt).toBeNull();
    expect(cleared!.estimatedMinutes).toBeNull();
    const [empty] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: cleared!.version, contentJson: plainTextDocument('') },
      'task-details',
    );
    expect(documentText(empty!.descriptionJson!)).toBe('');
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.setEstimate', id, estimatedMinutes: -1, baseVersion: empty!.version },
        'invalid',
      ),
    ).rejects.toThrow();
    const stored = await withUser(domain.db, userA, (tx) =>
      tx.select().from(tasks).where(eq(tasks.id, id)),
    );
    expect(stored[0]!.descriptionText).toBe('');
    await expect(
      withUser(domain.db, userA, (tx) =>
        tx.execute(sql`UPDATE tasks SET estimated_minutes = 0 WHERE id = ${id}`),
      ),
    ).rejects.toThrow();
  });
  it('opens one daily note per user/date concurrently and protects restore conflicts', async () => {
    const service = createCaptureService(domain.db);
    const date = '2026-10-02';
    const [first, second] = await Promise.all([
      service.execute(userA, v7(), { op: 'note.openDaily', id: v7(), date }, 'device-a'),
      service.execute(userA, v7(), { op: 'note.openDaily', id: v7(), date }, 'device-b'),
    ]);
    expect(first).toEqual(second);
    const daily = first[0]!;
    expect(daily).toMatchObject({ type: 'note', kind: 'daily', dailyDate: date });
    const history = await createNoteHistoryService(domain.db).list(userA, daily.id);
    expect(history.versions).toHaveLength(1);
    const [otherUser] = await service.execute(
      userB,
      v7(),
      { op: 'note.openDaily', id: v7(), date },
      'other-user',
    );
    expect(otherUser!.id).not.toBe(daily.id);
    const [edited] = await service.execute(
      userA,
      v7(),
      {
        op: 'note.updateContent',
        id: daily.id,
        baseVersion: daily.version,
        contentJson: plainTextDocument('My day'),
        contentSchemaVersion: 1,
      },
      'edit',
    );
    const [reopened] = await service.execute(
      userA,
      v7(),
      { op: 'note.openDaily', id: v7(), date },
      'reopen',
    );
    expect(reopened).toEqual(edited);
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: daily.id, baseVersion: edited!.version },
      'trash',
    );
    const [replacement] = await service.execute(
      userA,
      v7(),
      { op: 'note.openDaily', id: v7(), date },
      'replacement',
    );
    expect(replacement!.id).not.toBe(daily.id);
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'note.restore', id: daily.id, baseVersion: trashed!.version },
        'restore',
      ),
    ).rejects.toMatchObject({ code: 'DAILY_NOTE_EXISTS' });
    await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: replacement!.id, baseVersion: replacement!.version },
      'trash-replacement',
    );
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'note.restore', id: daily.id, baseVersion: trashed!.version },
      'restore',
    );
    expect(restored).toMatchObject({ text: 'My day', dailyDate: date, deletedAt: null });
    const [nextDay] = await service.execute(
      userA,
      v7(),
      { op: 'note.openDaily', id: v7(), date: '2026-10-03' },
      'next-day',
    );
    expect(nextDay!.id).not.toBe(daily.id);
  });
  it('searches current content with prefixes, typos, filters, pagination and owner isolation through HTTP', async () => {
    const service = createCaptureService(domain.db);
    const search = createSearchService(domain.db);
    const id = v7();
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: {
          id,
          type: 'note',
          text: 'Orchid café planning\nसमीक्षा weekly review',
          plannedDate: null,
        },
      },
      'search',
    );
    const [tagged] = await service.execute(
      userA,
      v7(),
      { op: 'item.setTags', id, tags: ['garden'], baseVersion: note!.version },
      'search',
    );
    const find = async (q: string, extra = {}): Promise<RecordItem[]> =>
      (
        await search.search(userA, searchQuerySchema.parse({ q, limit: 20, ...extra }))
      ).groups.flatMap((g) => g.records);
    expect(await find('orch cafe')).toContainEqual(tagged);
    expect(await find('समीक्षा')).toContainEqual(tagged);
    expect(await find('Orchid cafe planing')).toContainEqual(tagged);
    expect(await find('garden', { tag: 'garden', type: 'note' })).toEqual([tagged]);
    expect(await find('orchid', { tag: 'other' })).toEqual([]);
    expect(await find('orchid', { type: 'task' })).toEqual([]);
    expect(await find('orchid', { from: '2000-01-01', to: '2000-12-31' })).toEqual([]);
    expect(await find('orchid', { from: '2000-01-01', to: '2099-12-31' })).toContainEqual(tagged);
    const other = await search.search(userB, searchQuerySchema.parse({ q: 'orchid' }));
    expect(other.groups.flatMap((g) => g.records)).toEqual([]);
    const response = await app.inject({
      url: '/api/v1/search?q=orch&limit=20&includeArchived=false',
      headers: headers(tokenA),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json().groups.flatMap((g: { records: RecordItem[] }) => g.records),
    ).toContainEqual(tagged);
    expect(
      (await app.inject({ url: '/api/v1/search?q=orch&limit=51', headers: headers(tokenA) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/v1/search?q=orch&userId=' + userA, headers: headers(tokenB) }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/api/v1/search?q=orch' })).statusCode).toBe(401);
    for (let n = 0; n < 4; n++)
      await service.execute(
        userA,
        v7(),
        {
          op: 'capture',
          payload: { id: v7(), type: 'task', text: `Paginate violets ${n}`, plannedDate: null },
        },
        'search',
      );
    const first = await search.search(
      userA,
      searchQuerySchema.parse({ q: 'violets', type: 'task', limit: 2 }),
    );
    const second = await search.search(
      userA,
      searchQuerySchema.parse({ q: 'violets', type: 'task', limit: 2, offset: 2 }),
    );
    expect(first.groups[0]!.hasMore).toBe(true);
    expect(second.groups[0]!.hasMore).toBe(false);
    expect(
      new Set([...first.groups[0]!.records, ...second.groups[0]!.records].map((r) => r.id)).size,
    ).toBe(4);
    const [archived] = await service.execute(
      userA,
      v7(),
      { op: 'note.setArchived', id, archived: true, baseVersion: tagged!.version },
      'search',
    );
    expect(await find('orchid')).toEqual([]);
    expect(await find('orchid', { includeArchived: true })).toEqual([archived]);
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: archived!.version },
      'search',
    );
    expect(await find('orchid', { includeArchived: true })).toEqual([]);
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'note.restore', id, baseVersion: trashed!.version },
      'search',
    );
    expect(await find('orchid', { includeArchived: true })).toEqual([restored]);
    const [deleted] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id, baseVersion: restored!.version },
      'search',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id, baseVersion: deleted!.version },
      'search',
    );
    expect(
      (await owner.query('SELECT * FROM search_documents WHERE entity_id=$1', [id])).rows,
    ).toEqual([]);
  });
  it('matches search queries across Devanagari and Hinglish scripts', async () => {
    const service = createCaptureService(domain.db);
    const search = createSearchService(domain.db);
    const [deva] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id: v7(), type: 'note', text: 'मेरा घर', plannedDate: null } },
      'translit',
    );
    const [latin] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'kitaab list', plannedDate: null },
      },
      'translit',
    );
    const find = async (q: string): Promise<RecordItem[]> =>
      (await search.search(userA, searchQuerySchema.parse({ q, limit: 20 }))).groups.flatMap(
        (g) => g.records,
      );
    // Hinglish query finds the Devanagari note.
    expect(await find('ghar')).toContainEqual(deva);
    // Devanagari query finds the Hinglish note (किताब → kitaab → kitab).
    expect(await find('किताब')).toContainEqual(latin);
    // Vowel-length and script folding still find each record by its own script.
    expect(await find('घर')).toContainEqual(deva);
    expect(await find('kitab')).toContainEqual(latin);
    // Unrelated transliterated query does not match.
    expect(await find('paani')).toEqual([]);
  });
  it('links owned notes to projects and syncs link removal when notes are permanently deleted', async () => {
    const service = createCaptureService(domain.db);
    const [project] = await service.execute(
      userA,
      v7(),
      { op: 'project.create', id: v7(), name: 'Reference library', color: '#275D48' },
      'links',
    );
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Related reference', plannedDate: null },
      },
      'links',
    );
    const [foreign] = await service.execute(
      userB,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Private reference', plannedDate: null },
      },
      'links',
    );
    const command = {
      op: 'project.setNotes' as const,
      id: project!.id,
      baseVersion: project!.version,
      noteIds: [note!.id],
    };
    await expect(service.execute(userB, v7(), command, 'foreign-project')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(
      service.execute(userA, v7(), { ...command, noteIds: [foreign!.id] }, 'foreign-note'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await expect(
      service.execute(userA, v7(), { ...command, noteIds: [note!.id, note!.id] }, 'duplicate'),
    ).rejects.toThrow();
    const key = v7();
    const [linked] = await service.execute(userA, key, command, 'links');
    expect(linked!.relatedNoteIds).toEqual([note!.id]);
    expect(await service.execute(userA, key, command, 'retry')).toEqual([linked]);
    await expect(service.execute(userA, v7(), command, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect((await service.pull(userA, project!.version)).changes).toContainEqual(linked);
    const [unlinked] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: linked!.version, noteIds: [] },
      'unlink',
    );
    expect(unlinked!.relatedNoteIds).toEqual([]);
    expect(
      (await service.pull(userA, project!.version)).changes.find((r) => r.id === note!.id)?.text,
    ).toBe('Related reference');
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: note!.id, baseVersion: note!.version },
      'trash',
    );
    await expect(
      service.execute(userA, v7(), { ...command, baseVersion: unlinked!.version }, 'link-trash'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'note.restore', id: note!.id, baseVersion: trashed!.version },
      'restore',
    );
    const [relinked] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: unlinked!.version },
      'relink',
    );
    const [retrashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: note!.id, baseVersion: restored!.version },
      'trash',
    );
    const [retained] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: relinked!.version },
      'retain-existing-trash',
    );
    expect(retained!.relatedNoteIds).toEqual([note!.id]);
    const purgeKey = v7();
    const purge = { op: 'note.purge' as const, id: note!.id, baseVersion: retrashed!.version };
    const [cleaned] = await service.execute(userA, purgeKey, purge, 'purge');
    expect(cleaned).toMatchObject({ id: project!.id, relatedNoteIds: [], deletedAt: null });
    expect(cleaned!.version).toBeGreaterThan(retained!.version);
    expect(await service.execute(userA, purgeKey, purge, 'purge-retry')).toEqual([cleaned]);
    const page = await service.pull(userA, retained!.version);
    expect(page.changes).toContainEqual(cleaned);
    expect(page.tombstones).toContainEqual({
      id: note!.id,
      version: cleaned!.version,
      purgedAt: expect.any(String),
    });
    expect(
      (await service.pull(userB, foreign!.version)).changes.some((r) => r.id === project!.id),
    ).toBe(false);
  });
  it('links owned learning resources to projects and syncs link removal when resources are permanently deleted', async () => {
    const service = createCaptureService(domain.db);
    const [project] = await service.execute(
      userA,
      v7(),
      { op: 'project.create', id: v7(), name: 'Study plan', color: '#3563A5' },
      'resource-links',
    );
    const [resource] = await service.execute(
      userA,
      v7(),
      {
        op: 'resource.save',
        id: v7(),
        url: null,
        title: 'Related course',
        resourceType: 'course',
        source: 'manual',
        collectionId: null,
        externalId: null,
      },
      'resource-links',
    );
    const [foreign] = await service.execute(
      userB,
      v7(),
      {
        op: 'resource.save',
        id: v7(),
        url: null,
        title: 'Private course',
        resourceType: 'course',
        source: 'manual',
        collectionId: null,
        externalId: null,
      },
      'resource-links',
    );
    const command = {
      op: 'project.setResources' as const,
      id: project!.id,
      baseVersion: project!.version,
      resourceIds: [resource!.id],
    };
    await expect(service.execute(userB, v7(), command, 'foreign-project')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(
      service.execute(userA, v7(), { ...command, resourceIds: [foreign!.id] }, 'foreign-resource'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      service.execute(
        userA,
        v7(),
        { ...command, resourceIds: [resource!.id, resource!.id] },
        'duplicate',
      ),
    ).rejects.toThrow();
    const key = v7();
    const [linked] = await service.execute(userA, key, command, 'resource-links');
    expect(linked!.relatedResourceIds).toEqual([resource!.id]);
    expect(await service.execute(userA, key, command, 'retry')).toEqual([linked]);
    await expect(service.execute(userA, v7(), command, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect((await service.pull(userA, project!.version)).changes).toContainEqual(linked);
    const [unlinked] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: linked!.version, resourceIds: [] },
      'unlink',
    );
    expect(unlinked!.relatedResourceIds).toEqual([]);
    expect(
      (await service.pull(userA, project!.version)).changes.find((r) => r.id === resource!.id)
        ?.text,
    ).toBe('Related course');
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'resource.delete', id: resource!.id, baseVersion: resource!.version },
      'trash',
    );
    await expect(
      service.execute(userA, v7(), { ...command, baseVersion: unlinked!.version }, 'link-trash'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const [restored] = await service.execute(
      userA,
      v7(),
      { op: 'resource.restore', id: resource!.id, baseVersion: trashed!.version },
      'restore',
    );
    const [relinked] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: unlinked!.version },
      'relink',
    );
    const [retrashed] = await service.execute(
      userA,
      v7(),
      { op: 'resource.delete', id: resource!.id, baseVersion: restored!.version },
      'trash',
    );
    const [retained] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: relinked!.version },
      'retain-existing-trash',
    );
    expect(retained!.relatedResourceIds).toEqual([resource!.id]);
    const purgeKey = v7();
    const purge = {
      op: 'resource.purge' as const,
      id: resource!.id,
      baseVersion: retrashed!.version,
    };
    const [cleaned] = await service.execute(userA, purgeKey, purge, 'purge');
    expect(cleaned).toMatchObject({ id: project!.id, relatedResourceIds: [], deletedAt: null });
    expect(cleaned!.version).toBeGreaterThan(retained!.version);
    expect(await service.execute(userA, purgeKey, purge, 'purge-retry')).toEqual([cleaned]);
    const page = await service.pull(userA, retained!.version);
    expect(page.changes).toContainEqual(cleaned);
    expect(page.tombstones).toContainEqual({
      id: resource!.id,
      version: cleaned!.version,
      purgedAt: expect.any(String),
    });
    expect(
      (await service.pull(userB, foreign!.version)).changes.some((r) => r.id === project!.id),
    ).toBe(false);
  });
  it('persists owner-scoped note references atomically through retries, history, Trash and permanent purge', async () => {
    const service = createCaptureService(domain.db);
    const history = createNoteHistoryService(domain.db);
    const create = async (user: string, text: string) =>
      (
        await service.execute(
          user,
          v7(),
          { op: 'capture', payload: { id: v7(), type: 'note', text, plannedDate: null } },
          'references',
        )
      )[0]!;
    const source = await create(userA, 'Source'),
      target = await create(userA, 'Target'),
      foreign = await create(userB, 'Private target');
    const content = (id: string) =>
      readDocument({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Source' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'noteReference', attrs: { noteId: id }, marks: [{ type: 'bold' }] },
              { type: 'noteReference', attrs: { noteId: id } },
            ],
          },
        ],
      });
    const command = {
      op: 'note.updateContent' as const,
      id: source.id,
      baseVersion: source.version,
      contentJson: content(target.id),
      contentSchemaVersion: 1 as const,
    };
    const links = () =>
      withUser(domain.db, userA, (tx) =>
        tx.select().from(entityLinks).where(eq(entityLinks.sourceId, source.id)),
      );
    await expect(
      service.execute(userA, v7(), { ...command, contentJson: content(foreign.id) }, 'foreign'),
    ).rejects.toMatchObject({ code: 'NOTE_REFERENCE_NOT_FOUND' });
    expect(await links()).toEqual([]);
    const key = v7();
    const [linked] = await service.execute(userA, key, command, 'references');
    expect(await service.execute(userA, key, command, 'retry')).toEqual([linked]);
    expect(await links()).toMatchObject([{ targetId: target.id, relation: 'references' }]);
    expect((await links()).length).toBe(1);
    const snapshot = (await history.list(userA, source.id)).versions[0]!;
    await expect(service.execute(userA, v7(), command, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const [renamed] = await service.execute(
      userA,
      v7(),
      { op: 'note.edit', id: target.id, text: 'Renamed target', baseVersion: target.version },
      'rename',
    );
    expect((await links())[0]!.targetId).toBe(target.id);
    expect(
      (await service.pull(userA, source.version)).changes.find((r) => r.id === source.id)
        ?.contentJson,
    ).toEqual(command.contentJson);
    const [unlinked] = await service.execute(
      userA,
      v7(),
      { ...command, baseVersion: linked!.version, contentJson: plainTextDocument('No reference') },
      'unlink',
    );
    expect(await links()).toEqual([]);
    const [restored] = await service.execute(
      userA,
      v7(),
      {
        op: 'note.restoreVersion',
        id: source.id,
        versionId: snapshot.id,
        baseVersion: unlinked!.version,
      },
      'restore',
    );
    expect(await links()).toMatchObject([{ targetId: target.id, relation: 'references' }]);
    const [trashed] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: target.id, baseVersion: renamed!.version },
      'trash',
    );
    expect(await links()).toHaveLength(1);
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: target.id, baseVersion: trashed!.version },
      'purge',
    );
    expect(await links()).toEqual([]);
    // An old draft/history entry may retain an owned tombstone ID, but cannot revive its relation.
    const [afterPurge] = await service.execute(
      userA,
      v7(),
      {
        op: 'note.restoreVersion',
        id: source.id,
        versionId: snapshot.id,
        baseVersion: restored!.version,
      },
      'restore-purged-reference',
    );
    expect(afterPurge!.contentJson).toEqual(command.contentJson);
    expect(await links()).toEqual([]);
    await expect(
      service.execute(
        userA,
        v7(),
        { ...command, baseVersion: afterPurge!.version, contentJson: content(v7()) },
        'unknown',
      ),
    ).rejects.toMatchObject({ code: 'NOTE_REFERENCE_NOT_FOUND' });
    const sourceTrash = (
      await service.execute(
        userA,
        v7(),
        { op: 'note.delete', id: source.id, baseVersion: afterPurge!.version },
        'trash-source',
      )
    )[0]!;
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: source.id, baseVersion: sourceTrash.version },
      'purge-source',
    );
    expect(await links()).toEqual([]);
    expect(
      (await service.pull(userB, foreign.version)).changes.some((r) => r.id === source.id),
    ).toBe(false);
  });
  it('advances recurring tasks once, preserves occurrence edits and splits future schedules with RLS', async () => {
    const service = createCaptureService(domain.db);
    const [original] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: {
          id: v7(),
          type: 'task',
          text: 'Weekly review',
          plannedDate: '2026-01-05',
          dueDate: '2026-01-06',
        },
      },
      'repeat',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'task.addSubtask', id: v7(), parentId: original!.id, text: 'Prepare notes' },
      'repeat-child',
    );
    const recurrence = {
      frequency: 'WEEKLY' as const,
      interval: 1,
      weekdays: [0],
      lastDay: false,
      mode: 'fixed_schedule' as const,
      anchorDate: '2026-01-05',
      anchorTime: null,
      timeMode: 'floating' as const,
      timezone: 'Asia/Kolkata',
      endsOn: null,
      count: 3,
    };
    const configure = {
      op: 'task.setRecurrence' as const,
      id: original!.id,
      baseVersion: original!.version,
      recurrence,
    };
    await expect(service.execute(userB, v7(), configure, 'foreign')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    const [repeating] = await service.execute(userA, v7(), configure, 'repeat');
    expect(repeating!.recurrence).toMatchObject({
      occurrenceNumber: 1,
      occurrenceDate: '2026-01-05',
      advanced: false,
    });
    expect(await domain.db.select().from(recurrenceRules)).toEqual([]);
    expect(await withUser(domain.db, userB, (tx) => tx.select().from(recurrenceRules))).toEqual([]);
    await expect(
      withUser(domain.db, userB, (tx) =>
        tx
          .update(tasks)
          .set({ recurrenceRuleId: repeating!.recurrence!.ruleId })
          .where(eq(tasks.id, original!.id)),
      ),
    ).resolves.toBeDefined();
    const [foreignTask] = await service.execute(
      userB,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Private task', plannedDate: null },
      },
      'foreign-rule',
    );
    await expect(
      withUser(domain.db, userB, (tx) =>
        tx
          .update(tasks)
          .set({
            recurrenceRuleId: repeating!.recurrence!.ruleId,
            recurrenceSeriesId: v7(),
            occurrenceDate: '2026-01-05',
            occurrenceNumber: 1,
          })
          .where(eq(tasks.id, foreignTask!.id)),
      ),
    ).rejects.toThrow();
    const [edited] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.rename',
        id: original!.id,
        text: 'Only this review',
        scope: 'occurrence',
        baseVersion: repeating!.version,
      },
      'edit-one',
    );
    const key = v7();
    const complete = {
      op: 'task.complete' as const,
      id: original!.id,
      baseVersion: edited!.version,
      currentTimezone: 'Asia/Kolkata',
      occurredAt: '2026-01-20T12:00:00Z',
    };
    const results = await Promise.all([
      service.execute(userA, key, complete, 'first'),
      service.execute(userA, key, complete, 'retry'),
    ]);
    expect(results[0]).toEqual(results[1]);
    const done = results[0].find((r) => r.id === original!.id)!;
    const next = results[0].find((r) => r.recurrence && r.id !== original!.id)!;
    expect(next).toMatchObject({
      text: 'Weekly review',
      plannedDate: '2026-01-12',
      dueDate: '2026-01-13',
      status: 'todo',
    });
    expect(done.recurrence!.nextTaskId).toBe(next.id);
    expect(next.recurrence!.seriesId).toBe(done.recurrence!.seriesId);
    expect(results[0].filter((r) => r.parentId === next.id)).toMatchObject([
      { text: 'Prepare notes', status: 'todo' },
    ]);
    const reopened = (
      await service.execute(
        userA,
        v7(),
        { op: 'task.reopen', id: done.id, baseVersion: done.version },
        'reopen',
      )
    )[0]!;
    const completedAgain = await service.execute(
      userA,
      v7(),
      { ...complete, baseVersion: reopened.version },
      'complete-again',
    );
    expect(completedAgain).toHaveLength(1);
    await expect(
      service.execute(
        userA,
        v7(),
        {
          op: 'task.rename',
          id: done.id,
          text: 'No future rewrite',
          scope: 'future',
          baseVersion: completedAgain[0]!.version,
        },
        'past-future',
      ),
    ).rejects.toMatchObject({ code: 'RECURRENCE_ALREADY_ADVANCED' });
    const oldRule = next.recurrence!.ruleId;
    const [future] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.rename',
        id: next.id,
        text: 'Future review',
        scope: 'future',
        baseVersion: next.version,
      },
      'future',
    );
    expect(future!.recurrence!.ruleId).not.toBe(oldRule);
    expect(future!.recurrence!.settings.count).toBe(2);
    const skipped = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setStatus',
        id: next.id,
        status: 'cancelled',
        baseVersion: future!.version,
        occurredAt: '2026-01-21T12:00:00Z',
        currentTimezone: 'Asia/Kolkata',
      },
      'skip',
    );
    const last = skipped.find((r) => r.recurrence && r.id !== next.id)!;
    expect(last).toMatchObject({
      text: 'Future review',
      plannedDate: '2026-01-19',
      status: 'todo',
    });
    const final = await service.execute(
      userA,
      v7(),
      {
        op: 'task.complete',
        id: last.id,
        baseVersion: last.version,
        occurredAt: '2026-01-22T12:00:00Z',
      },
      'last',
    );
    expect(final).toHaveLength(1);
    expect(final[0]!.recurrence).toMatchObject({ advanced: true, nextTaskId: null });
    const page = await service.pull(userA, edited!.version);
    expect(page.changes.some((r) => r.id === last.id)).toBe(true);
    expect((await service.pull(userB, 0)).changes.some((r) => r.id === last.id)).toBe(false);
  });
  it('preserves explicit fixed instants and advances timed deadlines through daylight saving', async () => {
    const service = createCaptureService(domain.db);
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Clock transition', plannedDate: '2026-11-01' },
      },
      'clock',
    );
    const [timed] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setDeadline',
        id: task!.id,
        baseVersion: task!.version,
        deadline: {
          dueDate: '2026-11-01',
          dueTime: '01:30',
          timeMode: 'fixed',
          timezone: 'America/New_York',
          occurrence: 'later',
        },
      },
      'clock',
    );
    const [repeating] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setRecurrence',
        id: task!.id,
        baseVersion: timed!.version,
        recurrence: {
          frequency: 'DAILY',
          interval: 1,
          weekdays: [],
          lastDay: false,
          mode: 'fixed_schedule',
          anchorDate: '2026-11-01',
          anchorTime: '01:30',
          timeMode: 'fixed',
          timezone: 'America/New_York',
          count: 2,
          endsOn: null,
        },
      },
      'clock',
    );
    expect(repeating!.dueAt).toBe('2026-11-01T06:30:00.000Z');
    const records = await service.execute(
      userA,
      v7(),
      {
        op: 'task.complete',
        id: task!.id,
        baseVersion: repeating!.version,
        occurredAt: '2026-01-01T00:00:00Z',
      },
      'clock',
    );
    expect(records.find((r) => r.id !== task!.id)).toMatchObject({
      plannedDate: '2026-11-02',
      dueDate: '2026-11-02',
      dueAt: '2026-11-02T06:30:00.000Z',
    });
  });
  it('uses offline completion dates for after-completion schedules and stops repeating cleanly', async () => {
    const service = createCaptureService(domain.db);
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Water plants', plannedDate: '2026-01-01' },
      },
      'repeat-after',
    );
    const [repeating] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setRecurrence',
        id: task!.id,
        baseVersion: task!.version,
        recurrence: {
          frequency: 'DAILY',
          interval: 3,
          weekdays: [],
          lastDay: false,
          mode: 'after_completion',
          anchorDate: '2026-01-01',
          anchorTime: null,
          timeMode: 'floating',
          timezone: 'Asia/Kolkata',
          endsOn: null,
          count: null,
        },
      },
      'repeat-after',
    );
    const results = await service.execute(
      userA,
      v7(),
      {
        op: 'task.complete',
        id: task!.id,
        baseVersion: repeating!.version,
        occurredAt: '2026-01-05T23:30:00Z',
        currentTimezone: 'Asia/Kolkata',
      },
      'complete-offline',
    );
    const next = results.find((r) => r.id !== task!.id)!;
    expect(next.plannedDate).toBe('2026-01-09');
    const [stopped] = await service.execute(
      userA,
      v7(),
      { op: 'task.setRecurrence', id: next.id, baseVersion: next.version, recurrence: null },
      'stop',
    );
    expect(stopped!.recurrence).toBeNull();
    const completed = await service.execute(
      userA,
      v7(),
      { op: 'task.complete', id: next.id, baseVersion: stopped!.version },
      'finish',
    );
    expect(completed).toHaveLength(1);
    const [trash] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.delete',
        id: task!.id,
        baseVersion: results.find((r) => r.id === task!.id)!.version,
      },
      'trash',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'task.purge', id: task!.id, baseVersion: trash!.version },
      'purge',
    );
    expect(
      await withUser(domain.db, userA, (tx) =>
        tx
          .select()
          .from(recurrenceRules)
          .where(eq(recurrenceRules.id, repeating!.recurrence!.ruleId)),
      ),
    ).toEqual([]);
  });
  it('stores fixed and floating deadline intent, enforces DST choices and preserves owner/version boundaries', async () => {
    const service = createCaptureService(domain.db);
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Timed release', plannedDate: '2026-10-01' },
      },
      'deadline',
    );
    const id = task!.id;
    const deadline = {
      dueDate: '2026-11-01',
      dueTime: '01:30',
      timeMode: 'fixed' as const,
      timezone: 'America/New_York',
      occurrence: null,
    };
    await expect(
      service.execute(
        userA,
        v7(),
        { op: 'task.setDeadline', id, baseVersion: task!.version, deadline },
        'ambiguous',
      ),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TIME' });
    await expect(
      service.execute(
        userA,
        v7(),
        {
          op: 'task.setDeadline',
          id,
          baseVersion: task!.version,
          deadline: { ...deadline, dueDate: '2026-03-08', dueTime: '02:30' },
        },
        'gap',
      ),
    ).rejects.toMatchObject({ code: 'NONEXISTENT_TIME' });
    const key = v7();
    const command = {
      op: 'task.setDeadline' as const,
      id,
      baseVersion: task!.version,
      deadline: { ...deadline, occurrence: 'later' as const },
    };
    const [fixed] = await service.execute(userA, key, command, 'fixed');
    expect(fixed).toMatchObject({
      dueAt: '2026-11-01T06:30:00.000Z',
      dueTime: '01:30',
      timeMode: 'fixed',
      timezone: 'America/New_York',
      plannedDate: '2026-10-01',
    });
    expect(await service.execute(userA, key, command, 'retry')).toEqual([fixed]);
    expect((await service.pull(userA, task!.version)).changes).toContainEqual(fixed);
    await expect(service.execute(userA, v7(), command, 'stale')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      service.execute(userB, v7(), { ...command, baseVersion: fixed!.version }, 'foreign'),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const [floating] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setDeadline',
        id,
        baseVersion: fixed!.version,
        deadline: {
          dueDate: '2026-10-02',
          dueTime: '17:30',
          timeMode: 'floating',
          timezone: 'Asia/Kolkata',
          occurrence: null,
        },
      },
      'floating',
    );
    expect(floating).toMatchObject({
      dueAt: null,
      dueTime: '17:30',
      timeMode: 'floating',
      timezone: 'Asia/Kolkata',
    });
    const [dateOnly] = await service.execute(
      userA,
      v7(),
      { op: 'task.setDueDate', id, baseVersion: floating!.version, dueDate: '2026-10-03' },
      'date-only',
    );
    expect(dateOnly).toMatchObject({
      dueTime: null,
      dueAt: null,
      timeMode: 'floating',
      timezone: null,
    });
    await expect(
      withUser(domain.db, userA, (tx) =>
        tx.execute(sql`UPDATE tasks SET due_time='12:30' WHERE id=${id}`),
      ),
    ).rejects.toThrow();
    const [cleared] = await service.execute(
      userA,
      v7(),
      {
        op: 'task.setDeadline',
        id,
        baseVersion: dateOnly!.version,
        deadline: {
          dueDate: null,
          dueTime: null,
          timeMode: 'floating',
          timezone: null,
          occurrence: null,
        },
      },
      'clear',
    );
    expect(cleared!.dueDate).toBeNull();
  });
  it('sets task priority and a deadline separate from the planned date', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [task] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: {
          id,
          type: 'task',
          text: 'Ship release',
          plannedDate: '2026-10-01',
          dueDate: '2026-10-03',
        },
      },
      'test',
    );
    expect(task!.priority).toBe(0);
    expect(task!.dueDate).toBe('2026-10-03');
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
  it('moves a task through in_progress, done and cancelled', async () => {
    const service = createCaptureService(domain.db);
    const id = v7();
    const [task] = await service.execute(
      userA,
      v7(),
      { op: 'capture', payload: { id, type: 'task', text: 'Write report', plannedDate: null } },
      'test',
    );
    expect(task!.status).toBe('todo');
    const [started] = await service.execute(
      userA,
      v7(),
      { op: 'task.setStatus', id, status: 'in_progress', baseVersion: task!.version },
      'test',
    );
    expect(started!.status).toBe('in_progress');
    const [done] = await service.execute(
      userA,
      v7(),
      { op: 'task.setStatus', id, status: 'done', baseVersion: started!.version },
      'test',
    );
    expect(done!.status).toBe('done');
    await withUser(domain.db, userA, async (tx) => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
      expect(row?.completedAt).not.toBeNull();
    });
    const [cancelled] = await service.execute(
      userA,
      v7(),
      { op: 'task.setStatus', id, status: 'cancelled', baseVersion: done!.version },
      'test',
    );
    expect(cancelled!.status).toBe('cancelled');
    await withUser(domain.db, userA, async (tx) => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
      expect(row?.completedAt).toBeNull(); // clearing done clears the completion time
    });
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
      'note_versions',
      'note_folders',
      'projects',
      'search_documents',
      'recurrence_rules',
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
  it('enforces money invariants: split sums, void/restore revisions, RLS and balance reconciliation', async () => {
    const service = createCaptureService(domain.db);
    const exec = (user: string, command: Parameters<typeof service.execute>[2], hash = 'money') =>
      service.execute(user, v7(), command, hash);

    // People, accounts and two-level categories.
    const personId = v7();
    await exec(userA, { op: 'person.create', id: personId, name: 'Asha', nickname: null });
    const accountId = v7();
    const [account] = await exec(userA, {
      op: 'account.create',
      id: accountId,
      name: 'Checking',
      accountType: 'bank',
      isLiability: false,
      currency: 'INR',
      openingBalanceMinor: 100000,
      openingDate: '2026-01-01',
    });
    expect(account).toMatchObject({ cachedBalanceMinor: 100000, openingBalanceMinor: 100000 });
    const savingsId = v7();
    await exec(userA, {
      op: 'account.create',
      id: savingsId,
      name: 'Savings',
      accountType: 'savings',
      isLiability: false,
      currency: 'INR',
      openingBalanceMinor: 0,
      openingDate: '2026-01-01',
    });
    const parentCat = v7();
    await exec(userA, {
      op: 'category.create',
      id: parentCat,
      kind: 'expense',
      name: 'Food',
      parentId: null,
      icon: null,
      color: null,
    });
    const childCat = v7();
    await exec(userA, {
      op: 'category.create',
      id: childCat,
      kind: 'expense',
      name: 'Groceries',
      parentId: parentCat,
      icon: null,
      color: null,
    });
    const diningCat = v7();
    await exec(userA, {
      op: 'category.create',
      id: diningCat,
      kind: 'expense',
      name: 'Dining',
      parentId: parentCat,
      icon: null,
      color: null,
    });
    // Categories support only two levels.
    await expect(
      exec(userA, {
        op: 'category.create',
        id: v7(),
        kind: 'expense',
        name: 'Too deep',
        parentId: childCat,
        icon: null,
        color: null,
      }),
    ).rejects.toMatchObject({ code: 'CATEGORY_TOO_DEEP' });

    // A transaction's splits must sum to its amount.
    await expect(
      exec(userA, {
        op: 'transaction.create',
        id: v7(),
        transactionType: 'expense',
        accountId,
        toAccountId: null,
        amountMinor: 10000,
        currency: 'INR',
        toAmountMinor: null,
        adjustmentSign: null,
        transactionDate: '2026-02-01',
        description: 'Bad split',
        merchant: null,
        paymentMethod: null,
        personId: null,
        debtId: null,
        source: 'app',
        splits: [
          {
            id: v7(),
            kind: 'category',
            categoryId: childCat,
            amountMinor: 6000,
            personId: null,
            debtId: null,
            note: null,
          },
          {
            id: v7(),
            kind: 'category',
            categoryId: diningCat,
            amountMinor: 3000,
            personId: null,
            debtId: null,
            note: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SPLITS_MISMATCH' });
    // An unknown account is rejected.
    await expect(
      exec(userA, {
        op: 'transaction.create',
        id: v7(),
        transactionType: 'expense',
        accountId: v7(),
        toAccountId: null,
        amountMinor: 5000,
        currency: 'INR',
        toAmountMinor: null,
        adjustmentSign: null,
        transactionDate: '2026-02-01',
        description: 'No account',
        merchant: null,
        paymentMethod: null,
        personId: null,
        debtId: null,
        source: 'app',
        splits: [],
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    // Posted transactions that drive the balance:
    //   income +50000, expense -20000 (balanced splits), transfer -30000 to Savings,
    //   adjustment -10000. Expected Checking = 90000, Savings = 30000.
    await exec(userA, {
      op: 'transaction.create',
      id: v7(),
      transactionType: 'income',
      accountId,
      toAccountId: null,
      amountMinor: 50000,
      currency: 'INR',
      toAmountMinor: null,
      adjustmentSign: null,
      transactionDate: '2026-02-02',
      description: 'Salary',
      merchant: null,
      paymentMethod: null,
      personId: null,
      debtId: null,
      source: 'app',
      splits: [],
    });
    const expenseId = v7();
    const [expense] = await exec(userA, {
      op: 'transaction.create',
      id: expenseId,
      transactionType: 'expense',
      accountId,
      toAccountId: null,
      amountMinor: 20000,
      currency: 'INR',
      toAmountMinor: null,
      adjustmentSign: null,
      transactionDate: '2026-02-03',
      description: 'Shopping',
      merchant: 'Market',
      paymentMethod: 'upi',
      personId: null,
      debtId: null,
      source: 'app',
      splits: [
        {
          id: v7(),
          kind: 'category',
          categoryId: childCat,
          amountMinor: 12000,
          personId: null,
          debtId: null,
          note: null,
        },
        {
          id: v7(),
          kind: 'category',
          categoryId: diningCat,
          amountMinor: 8000,
          personId: null,
          debtId: null,
          note: null,
        },
      ],
    });
    expect(expense!.splits).toHaveLength(2);
    await exec(userA, {
      op: 'transaction.create',
      id: v7(),
      transactionType: 'transfer',
      accountId,
      toAccountId: savingsId,
      amountMinor: 30000,
      currency: 'INR',
      toAmountMinor: 30000,
      adjustmentSign: null,
      transactionDate: '2026-02-04',
      description: 'To savings',
      merchant: null,
      paymentMethod: null,
      personId: null,
      debtId: null,
      source: 'app',
      splits: [],
    });
    await exec(userA, {
      op: 'transaction.create',
      id: v7(),
      transactionType: 'adjustment',
      accountId,
      toAccountId: null,
      amountMinor: 10000,
      currency: 'INR',
      toAmountMinor: null,
      adjustmentSign: -1,
      transactionDate: '2026-02-05',
      description: 'Correction',
      merchant: null,
      paymentMethod: null,
      personId: null,
      debtId: null,
      source: 'app',
      splits: [],
    });

    // Edit requires the current version, re-validates splits and records a revision.
    await expect(
      exec(userA, {
        op: 'transaction.edit',
        id: expenseId,
        amountMinor: 25000,
        splits: [
          {
            id: v7(),
            kind: 'category',
            categoryId: childCat,
            amountMinor: 20000,
            personId: null,
            debtId: null,
            note: null,
          },
        ],
        reason: 'fix',
        baseVersion: expense!.version,
      }),
    ).rejects.toMatchObject({ code: 'SPLITS_MISMATCH' });
    const [edited] = await exec(userA, {
      op: 'transaction.edit',
      id: expenseId,
      amountMinor: 25000,
      splits: [
        {
          id: v7(),
          kind: 'category',
          categoryId: childCat,
          amountMinor: 25000,
          personId: null,
          debtId: null,
          note: null,
        },
      ],
      reason: 'fix',
      baseVersion: expense!.version,
    });
    expect(edited!.amountMinor).toBe(25000);
    expect(edited!.splits).toHaveLength(1);
    // A stale edit is rejected.
    await expect(
      exec(userA, {
        op: 'transaction.edit',
        id: expenseId,
        description: 'stale',
        reason: null,
        baseVersion: expense!.version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    // Void / restore lifecycle with guards.
    const [voided] = await exec(userA, {
      op: 'transaction.void',
      id: expenseId,
      reason: 'duplicate',
      baseVersion: edited!.version,
    });
    expect(voided!.transactionStatus).toBe('void');
    await expect(
      exec(userA, {
        op: 'transaction.edit',
        id: expenseId,
        description: 'no edits when void',
        reason: null,
        baseVersion: voided!.version,
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_VOID' });
    await expect(
      exec(userA, {
        op: 'transaction.void',
        id: expenseId,
        reason: null,
        baseVersion: voided!.version,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_VOID' });
    const [restored] = await exec(userA, {
      op: 'transaction.restore',
      id: expenseId,
      baseVersion: voided!.version,
    });
    expect(restored!.transactionStatus).toBe('posted');
    await expect(
      exec(userA, { op: 'transaction.restore', id: expenseId, baseVersion: restored!.version }),
    ).rejects.toMatchObject({ code: 'NOT_VOID' });
    // The restored expense was edited to 25000, so Checking loses 5000 more.
    const revisions = await owner.query(
      'SELECT reason FROM transaction_revisions WHERE transaction_id=$1 ORDER BY created_at',
      [expenseId],
    );
    expect(revisions.rows.map((r) => r.reason)).toEqual([
      'created',
      'fix',
      'duplicate',
      'restored',
    ]);

    // Debts require a known person; status transitions are owner-scoped.
    const debtId = v7();
    const [debt] = await exec(userA, {
      op: 'debt.create',
      id: debtId,
      personId,
      direction: 'owed_to_me',
      currency: 'INR',
      title: 'Lunch',
      dueOn: null,
    });
    await expect(
      exec(userA, {
        op: 'debt.create',
        id: v7(),
        personId: v7(),
        direction: 'i_owe',
        currency: 'INR',
        title: null,
        dueOn: null,
      }),
    ).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' });
    const [writtenOff] = await exec(userA, {
      op: 'debt.writeOff',
      id: debtId,
      baseVersion: debt!.version,
    });
    expect(writtenOff!.manualStatus).toBe('written_off');

    // Cross-account isolation: userB cannot touch userA's transaction.
    await expect(
      exec(userB, {
        op: 'transaction.void',
        id: expenseId,
        reason: null,
        baseVersion: restored!.version,
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });

    // Balance reconciliation is the ledger invariant. Expense is 25000 now.
    const first = await reconcileBalances(maintenance.db);
    const driftFor = (id: string) => first.drifts.find((d) => d.accountId === id);
    expect(driftFor(accountId)).toMatchObject({ computed: 100000 + 50000 - 25000 - 30000 - 10000 });
    expect(driftFor(savingsId)).toMatchObject({ computed: 30000 });
    // Cached balances are corrected, so a second pass finds no drift.
    const second = await reconcileBalances(maintenance.db);
    expect(second.drifts).toEqual([]);
    const checking = await owner.query(
      'SELECT cached_balance_minor FROM finance_accounts WHERE id=$1',
      [accountId],
    );
    expect(Number(checking.rows[0].cached_balance_minor)).toBe(85000);
  });
  it('runs nightly maintenance under the dedicated least-privilege role', async () => {
    const service = createCaptureService(domain.db);
    // A note that was purged long ago is hard-deleted by the Trash cleanup.
    const noteId = v7();
    const [note] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: noteId, type: 'note', text: 'Old trash', plannedDate: null },
      },
      'maint',
    );
    const [deleted] = await service.execute(
      userA,
      v7(),
      { op: 'note.delete', id: noteId, baseVersion: note!.version },
      'maint',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'note.purge', id: noteId, baseVersion: deleted!.version },
      'maint',
    );
    // Backdate the purge so it falls outside the 30-day Trash window.
    await owner.query("UPDATE entities SET purged_at = now() - interval '31 days' WHERE id = $1", [
      noteId,
    ]);
    const purged = await cleanupTrash(maintenance.db);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await owner.query('SELECT 1 FROM entities WHERE id=$1', [noteId])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM notes WHERE id=$1', [noteId])).rowCount).toBe(0);

    // Tombstone cleanup removes entities purged beyond the 180-day window.
    const toppleId = v7();
    const [t] = await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: toppleId, type: 'task', text: 'Old tombstone', plannedDate: null },
      },
      'maint',
    );
    const [td] = await service.execute(
      userA,
      v7(),
      { op: 'task.delete', id: toppleId, baseVersion: t!.version },
      'maint',
    );
    await service.execute(
      userA,
      v7(),
      { op: 'task.purge', id: toppleId, baseVersion: td!.version },
      'maint',
    );
    await owner.query("UPDATE entities SET purged_at = now() - interval '181 days' WHERE id = $1", [
      toppleId,
    ]);
    expect(await cleanupTombstones(maintenance.db)).toBeGreaterThanOrEqual(1);
    expect((await owner.query('SELECT 1 FROM entities WHERE id=$1', [toppleId])).rowCount).toBe(0);

    // Idempotency keys older than seven days are removed.
    const staleKey = v7();
    await service.execute(
      userA,
      staleKey,
      { op: 'capture', payload: { id: v7(), type: 'inbox', text: 'keeps key', plannedDate: null } },
      'maint',
    );
    await owner.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '8 days' WHERE key = $1",
      [staleKey],
    );
    expect(await cleanupIdempotencyKeys(maintenance.db)).toBeGreaterThanOrEqual(1);
    expect(
      (await owner.query('SELECT 1 FROM idempotency_keys WHERE key=$1', [staleKey])).rowCount,
    ).toBe(0);

    // Ready exports older than 24 hours are expired.
    const exportId = v7();
    await owner.query(
      `INSERT INTO export_jobs (id, user_id, format, scope, status, completed_at, created_at)
       VALUES ($1, $2, 'json', 'everything', 'ready', now() - interval '25 hours', now() - interval '25 hours')`,
      [exportId, userA],
    );
    expect(await expireExports(maintenance.db)).toBeGreaterThanOrEqual(1);
    expect(
      (await owner.query('SELECT status FROM export_jobs WHERE id=$1', [exportId])).rows[0].status,
    ).toBe('expired');

    // The sync relay role remains restricted to outbox metadata.
    const relay = new Pool({
      connectionString: (() => {
        const u = new URL(container.getConnectionUri());
        u.username = 'personalspace_worker';
        u.password = 'local_worker_only';
        return u.href;
      })(),
    });
    try {
      await expect(relay.query('SELECT * FROM finance_accounts')).rejects.toThrow();
    } finally {
      await relay.end();
    }
  });
  it('delivers due reminders idempotently to server-push devices under the background role', async () => {
    const service = createCaptureService(domain.db);
    const reminderId = v7();
    await service.execute(
      userA,
      v7(),
      {
        op: 'reminder.create',
        id: reminderId,
        entityId: null,
        title: 'Drink water',
        remindDate: '2026-10-04',
        remindTime: '16:00',
        timeMode: 'fixed',
        timezone: 'Asia/Kolkata',
      },
      'reminder',
    );
    // Make it due now.
    await owner.query(
      "UPDATE reminders SET fire_at = now() - interval '5 minutes', status='scheduled', last_fired_at=NULL WHERE id=$1",
      [reminderId],
    );
    // One device needs a server push; one already scheduled it locally (watermark ahead).
    await owner.query(
      "INSERT INTO device_tokens (user_id, platform, token) VALUES ($1,'android','push-device')",
      [userA],
    );
    await owner.query(
      "INSERT INTO device_tokens (user_id, platform, token, reminders_scheduled_through) VALUES ($1,'ios','local-device', now() + interval '1 day')",
      [userA],
    );
    // Another account's device must never receive this reminder.
    await owner.query(
      "INSERT INTO device_tokens (user_id, platform, token) VALUES ($1,'android','other-device')",
      [userB],
    );

    expect(await deliverDueReminders(maintenance.db)).toBe(1);
    const logs = await owner.query(
      'SELECT user_id, type, channel, dedupe_key FROM notification_log WHERE entity_id=$1',
      [reminderId],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ user_id: userA, type: 'reminder', channel: 'push' });
    expect(logs.rows[0].dedupe_key).toContain('push-device');

    // Re-running is idempotent: the reminder is no longer due and no duplicate push is logged.
    expect(await deliverDueReminders(maintenance.db)).toBe(0);
    expect(
      (await owner.query('SELECT 1 FROM notification_log WHERE entity_id=$1', [reminderId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await owner.query('SELECT last_fired_at FROM reminders WHERE id=$1', [reminderId])).rows[0]
        .last_fired_at,
    ).not.toBeNull();
  });
  it('sends pending transactional emails to the recipient under the background role', async () => {
    const dedupe = `email-test-${v7()}`;
    await owner.query(
      `INSERT INTO notification_log (user_id, type, dedupe_key, title, body, channel, status)
       VALUES ($1, 'export_ready', $2, 'Your export is ready', 'Download it within 24 hours.', 'email', 'pending')`,
      [userA, dedupe],
    );
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    const provider = {
      async sendEmail(to: string, subject: string, body: string) {
        sent.push({ to, subject, body });
      },
    };
    // The background role can read only id+email from auth_user (column grant).
    // Other pending emails (e.g. sign-up verification) may also be delivered.
    expect(await processPendingEmails(maintenance.db, provider)).toBeGreaterThanOrEqual(1);
    expect(sent).toContainEqual({
      to: 'a@example.test',
      subject: 'Your export is ready',
      body: 'Download it within 24 hours.',
    });
    const row = await owner.query(
      'SELECT status, sent_at FROM notification_log WHERE dedupe_key=$1',
      [dedupe],
    );
    expect(row.rows[0]).toMatchObject({ status: 'sent' });
    expect(row.rows[0].sent_at).not.toBeNull();
    // Already-sent rows are not reprocessed.
    const delivered = sent.length;
    expect(await processPendingEmails(maintenance.db, provider)).toBe(0);
    expect(sent).toHaveLength(delivered);
    // The column grant does not expose credentials: selecting password-bearing
    // auth_account is denied for the background role.
    await expect(maintenance.db.execute(sql`SELECT password FROM auth_account`)).rejects.toThrow();
  });
  it('generates a cross-domain, owner-scoped export under the background role', async () => {
    const service = createCaptureService(domain.db);
    const noteId = v7();
    const taskId = v7();
    const acctId = v7();
    await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: noteId, type: 'note', text: 'Export me note', plannedDate: null },
      },
      'exp',
    );
    await service.execute(
      userA,
      v7(),
      {
        op: 'capture',
        payload: { id: taskId, type: 'task', text: 'Export me task', plannedDate: null },
      },
      'exp',
    );
    await service.execute(
      userA,
      v7(),
      {
        op: 'account.create',
        id: acctId,
        name: 'Export Acct',
        accountType: 'cash',
        isLiability: false,
        currency: 'INR',
        openingBalanceMinor: 0,
        openingDate: '2026-01-01',
      },
      'exp',
    );
    const foreignNote = v7();
    await service.execute(
      userB,
      v7(),
      {
        op: 'capture',
        payload: { id: foreignNote, type: 'note', text: 'Private note B', plannedDate: null },
      },
      'exp',
    );

    const ids = (rows: unknown[] | undefined) =>
      (rows as Array<{ id: string }> | undefined)?.map((r) => r.id) ?? [];
    // Reading across every domain table succeeds under the background role.
    const data = await generateExportData(maintenance.db, userA, 'everything');
    expect(ids(data.notes)).toContain(noteId);
    expect(ids(data.tasks)).toContain(taskId);
    expect(ids(data.accounts)).toContain(acctId);
    // Owner isolation: another account's data is never included.
    expect(ids(data.notes)).not.toContain(foreignNote);
    const json = exportToJson(data);
    expect(json).toContain('Export me note');
    expect(json).not.toContain('Private note B');

    // A scoped export only includes that domain.
    const moneyOnly = await generateExportData(maintenance.db, userA, 'money');
    expect(moneyOnly.notes).toBeUndefined();
    expect(ids(moneyOnly.accounts)).toContain(acctId);
  });
  it('fetches learning-resource metadata under the background role', async () => {
    const service = createCaptureService(domain.db);
    const resourceId = v7();
    const url = 'https://example.com/great-article';
    // Saving with title === url lets the fetched title replace the placeholder.
    await service.execute(
      userA,
      v7(),
      {
        op: 'resource.save',
        id: resourceId,
        url,
        title: url,
        resourceType: 'article',
        source: 'manual',
        collectionId: null,
        externalId: null,
      },
      'meta',
    );
    const html =
      '<html><head>' +
      '<meta property="og:title" content="Great Article"/>' +
      '<meta property="og:description" content="A deep dive."/>' +
      '<meta property="og:image" content="https://example.com/thumb.png"/>' +
      '</head></html>';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    try {
      expect(await processPendingMetadata(maintenance.db)).toBeGreaterThanOrEqual(1);
    } finally {
      fetchMock.mockRestore();
    }
    const row = await owner.query(
      'SELECT title, description, thumbnail_url, metadata_status FROM learning_resources WHERE id=$1',
      [resourceId],
    );
    expect(row.rows[0]).toMatchObject({
      title: 'Great Article',
      description: 'A deep dive.',
      thumbnail_url: 'https://example.com/thumb.png',
      metadata_status: 'ok',
    });
  });
  it('executes an expired account-deletion under the background role, owner-scoped', async () => {
    // A throwaway account so the wipe does not disturb userA/userB fixtures.
    const signup = await app.inject({
      remoteAddress: '127.0.0.21',
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: {
        name: 'Doomed User',
        email: 'doomed@example.test',
        password: 'a-test-password-123',
        ageConfirmed: true,
        termsAccepted: true,
      },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const userC = signup.json<{ user: { id: string } }>().user.id;
    const service = createCaptureService(domain.db);
    const noteId = v7();
    await service.execute(
      userC,
      v7(),
      {
        op: 'capture',
        payload: { id: noteId, type: 'note', text: 'Doomed note', plannedDate: null },
      },
      'del',
    );
    await service.execute(
      userC,
      v7(),
      {
        op: 'capture',
        payload: { id: v7(), type: 'task', text: 'Doomed task', plannedDate: null },
      },
      'del',
    );
    await service.execute(
      userC,
      v7(),
      {
        op: 'account.create',
        id: v7(),
        name: 'Doomed Acct',
        accountType: 'cash',
        isLiability: false,
        currency: 'INR',
        openingBalanceMinor: 0,
        openingDate: '2026-01-01',
      },
      'del',
    );
    const countFor = async (table: string) =>
      Number(
        (await owner.query(`SELECT count(*)::int c FROM ${table} WHERE user_id=$1`, [userC]))
          .rows[0].c,
      );
    expect(await countFor('entities')).toBeGreaterThan(0);
    expect(await countFor('search_documents')).toBeGreaterThan(0);

    // A deletion request whose grace period has already lapsed.
    await owner.query(
      "INSERT INTO deletion_requests (user_id, status, grace_ends_at) VALUES ($1, 'pending', now() - interval '1 day')",
      [userC],
    );

    expect(await executePendingDeletions(maintenance.db, async () => {})).not.toContain(userC);
    expect(
      (await owner.query('SELECT status,step FROM deletion_requests WHERE user_id=$1', [userC]))
        .rows[0],
    ).toEqual({ status: 'processing', step: 'awaiting_storage_expiry' });
    await owner.query(
      "UPDATE deletion_requests SET storage_cleanup_after=now()-interval '1 second' WHERE user_id=$1",
      [userC],
    );
    const deleted = await executePendingDeletions(maintenance.db, async () => {});
    expect(deleted).toContain(userC);

    // Every domain/infra table for the user is emptied.
    for (const table of [
      'entities',
      'notes',
      'tasks',
      'finance_accounts',
      'search_documents',
      'audit_logs',
      'outbox_events',
      'idempotency_keys',
      'user_sync_state',
      'recurrence_rules',
      'inbox_items',
    ])
      expect(await countFor(table)).toBe(0);

    // The ledger row is kept and marked completed.
    expect(
      (await owner.query('SELECT status FROM deletion_requests WHERE user_id=$1', [userC])).rows[0]
        .status,
    ).toBe('completed');
    // The auth row survives as a ledger anchor but its PII is anonymized, and the
    // credential/session rows are gone.
    const authRow = await owner.query('SELECT email, name, image FROM auth_user WHERE id=$1', [
      userC,
    ]);
    expect(authRow.rowCount).toBe(1);
    expect(authRow.rows[0]).toMatchObject({ name: 'Deleted User', image: null });
    expect(authRow.rows[0].email).toBe(`deleted+${userC}@deleted.invalid`);
    expect(
      (await owner.query('SELECT 1 FROM auth_account WHERE user_id=$1', [userC])).rowCount,
    ).toBe(0);
    expect(
      (await owner.query('SELECT 1 FROM auth_session WHERE user_id=$1', [userC])).rowCount,
    ).toBe(0);

    // Owner isolation: userA's data is untouched.
    expect(
      Number(
        (await owner.query('SELECT count(*)::int c FROM entities WHERE user_id=$1', [userA]))
          .rows[0].c,
      ),
    ).toBeGreaterThan(0);
  });
  it('queues verification and password-reset emails through the notification log', async () => {
    const email = `reset-${v7()}@example.test`;
    const signup = await app.inject({
      remoteAddress: '127.0.0.22',
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: {
        name: 'Reset User',
        email,
        password: 'a-test-password-123',
        ageConfirmed: true,
        termsAccepted: true,
      },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const userId = signup.json<{ user: { id: string } }>().user.id;
    // A verification email is queued on sign-up.
    expect(
      (
        await owner.query(
          "SELECT 1 FROM notification_log WHERE user_id=$1 AND channel='email' AND dedupe_key LIKE 'verify_%'",
          [userId],
        )
      ).rowCount,
    ).toBeGreaterThanOrEqual(1);

    // Requesting a password reset queues a reset email (and never reveals account existence).
    const reset = await app.inject({
      remoteAddress: '127.0.0.22',
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: { email, redirectTo: 'personalspace://reset' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM notification_log WHERE user_id=$1 AND dedupe_key LIKE 'reset_%'",
          [userId],
        )
      ).rowCount,
    ).toBeGreaterThanOrEqual(1);
  });
  it('reads and updates user preferences over the HTTP contract', async () => {
    const get = await app.inject({ url: '/api/v1/preferences', headers: headers(tokenA) });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().data).toMatchObject({ theme: expect.any(String) });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/preferences',
      headers: headers(tokenA),
      payload: { theme: 'dark', notificationReminder: false, weekStartDay: 1 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().data).toMatchObject({
      theme: 'dark',
      notificationReminder: false,
      weekStartDay: 1,
    });
    const after = await app.inject({ url: '/api/v1/preferences', headers: headers(tokenA) });
    expect(after.json().data).toMatchObject({ theme: 'dark', notificationReminder: false });
  });
  it('registers devices idempotently and updates UUIDv4 watermarks with owner RLS', async () => {
    const token = `test-device-${v7()}`;
    const register = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: headers(tokenA),
        payload: { platform: 'android', token, deviceName: 'Test device' },
      });
    const [first, retry] = await Promise.all([register(), register()]);
    expect(first.statusCode, first.body).toBe(200);
    expect(retry.statusCode, retry.body).toBe(200);
    const id = first.json().data.id as string;
    expect(id[14]).toBe('4');
    expect(retry.json().data.id).toBe(id);
    const watermark = '2026-10-10T10:00:00.000Z';
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${id}/watermark`,
      headers: headers(tokenA),
      payload: { remindersScheduledThrough: watermark },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(
      (
        await owner.query('SELECT reminders_scheduled_through FROM device_tokens WHERE id=$1', [id])
      ).rows[0].reminders_scheduled_through.toISOString(),
    ).toBe(watermark);
    await register();
    expect(
      (
        await owner.query('SELECT reminders_scheduled_through FROM device_tokens WHERE id=$1', [id])
      ).rows[0].reminders_scheduled_through.toISOString(),
    ).toBe(watermark);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${id}`,
      headers: headers(tokenA),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await owner.query('SELECT id FROM device_tokens WHERE id=$1', [id])).rows).toEqual([]);
  });
  it('rejects unauthenticated device writes and hides foreign and missing devices identically', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: headers(tokenB),
      payload: { platform: 'ios', token: `foreign-device-${v7()}` },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const foreignId = registered.json().data.id as string;
    for (const id of [foreignId, v7()]) {
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${id}/watermark`,
        headers: headers(tokenA),
        payload: { remindersScheduledThrough: '2026-10-10T10:00:00Z' },
      });
      expect(patch.statusCode, patch.body).toBe(404);
      expect(patch.json().error.code).toBe('DEVICE_NOT_FOUND');
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/devices/${id}`,
        headers: headers(tokenA),
      });
      expect(removed.statusCode, removed.body).toBe(404);
      expect(removed.json().error.code).toBe('DEVICE_NOT_FOUND');
    }
    expect(
      (
        await owner.query('SELECT reminders_scheduled_through FROM device_tokens WHERE id=$1', [
          foreignId,
        ])
      ).rows[0].reminders_scheduled_through,
    ).toBeNull();
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url:
          method === 'POST'
            ? '/api/v1/devices'
            : `/api/v1/devices/${foreignId}${method === 'PATCH' ? '/watermark' : ''}`,
      });
      expect(res.statusCode).toBe(401);
    }
  });
  it('requests, reads and cancels account deletion through owner RLS and queues one confirmation per request', async () => {
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/account/delete',
        headers: headers(tokenA),
        payload: { confirmText: 'DELETE', reason: 'Test request' },
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const created = responses.find((r) => r.statusCode === 200)!.json().data;
    expect(new Date(created.graceEndsAt).getTime() - new Date(created.createdAt).getTime()).toBe(
      14 * 86400000,
    );
    const own = await app.inject({ url: '/api/v1/account/delete', headers: headers(tokenA) });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data.status).toBe('pending');
    const foreign = await app.inject({ url: '/api/v1/account/delete', headers: headers(tokenB) });
    expect(foreign.json().data.status).toBe('none');
    expect(
      (await owner.query('SELECT reason FROM deletion_requests WHERE user_id=$1', [userA])).rows[0]
        .reason,
    ).toBe('Test request');
    const confirmations = () =>
      owner.query(
        "SELECT id FROM notification_log WHERE user_id=$1 AND dedupe_key LIKE 'deletion_request_%'",
        [userA],
      );
    expect((await confirmations()).rowCount).toBe(1);
    const cancel = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/delete',
      headers: headers(tokenA),
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().data.status).toBe('cancelled');
    const again = await request();
    expect(again.statusCode, again.body).toBe(200);
    expect((await confirmations()).rowCount).toBe(2);
    expect(
      (
        await owner.query(
          'SELECT cancelled_at, started_at FROM deletion_requests WHERE user_id=$1',
          [userA],
        )
      ).rows[0],
    ).toEqual({ cancelled_at: null, started_at: null });
    await cancelDeletion(domain.db, userA);
  });
  it('rolls back a deletion request when confirmation enqueue fails and refuses expired or started cancellations', async () => {
    await owner.query(`CREATE FUNCTION reject_deletion_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${userB}'::uuid AND NEW.dedupe_key LIKE 'deletion_request_%' THEN
          RAISE EXCEPTION 'simulated email enqueue failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_deletion_email BEFORE INSERT ON notification_log
      FOR EACH ROW EXECUTE FUNCTION reject_deletion_email();`);
    try {
      await expect(requestDeletion(domain.db, userB)).rejects.toThrow();
      expect(
        (await owner.query('SELECT id FROM deletion_requests WHERE user_id=$1', [userB])).rowCount,
      ).toBe(0);
    } finally {
      await owner.query(
        'DROP TRIGGER reject_deletion_email ON notification_log; DROP FUNCTION reject_deletion_email()',
      );
    }
    await requestDeletion(domain.db, userB);
    await owner.query(
      "UPDATE deletion_requests SET grace_ends_at=now()-interval '1 second' WHERE user_id=$1",
      [userB],
    );
    await expect(cancelDeletion(domain.db, userB)).rejects.toMatchObject({
      code: 'DELETION_NOT_CANCELLABLE',
    });
    for (const status of ['processing', 'completed']) {
      await owner.query('UPDATE deletion_requests SET status=$2 WHERE user_id=$1', [userB, status]);
      await expect(requestDeletion(domain.db, userB)).rejects.toMatchObject({
        code: 'DELETION_ALREADY_REQUESTED',
      });
      await expect(cancelDeletion(domain.db, userB)).rejects.toMatchObject({
        code: 'DELETION_NOT_CANCELLABLE',
      });
    }
    await owner.query(
      "UPDATE deletion_requests SET status='pending',started_at=now(),grace_ends_at=now()+interval '1 day' WHERE user_id=$1",
      [userB],
    );
    await expect(cancelDeletion(domain.db, userB)).rejects.toMatchObject({
      code: 'DELETION_NOT_CANCELLABLE',
    });
    await owner.query("UPDATE deletion_requests SET status='cancelled' WHERE user_id=$1", [userB]);
  });
});
