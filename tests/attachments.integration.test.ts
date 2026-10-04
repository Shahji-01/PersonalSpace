import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { v7 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createDatabase, attachments, withUser } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import {
  createAttachmentService,
  createAttachmentProcessor,
  createCaptureService,
  createNoteHistoryService,
} from '../packages/domain/src/index';
import {
  processAttachment,
  relayAttachmentProcessing,
} from '../apps/worker/src/attachment-processing';
import { createS3Storage, readStorageConfig } from '../packages/storage/src/index';
import { createApp } from '../apps/api/src/app';
import { cleanAttachment } from '../apps/worker/src/attachment-cleanup';
import {
  attachmentUploadStateSchema,
  attachmentUploadGrantSchema,
  type AttachmentDescriptor,
  type UploadedPart,
} from '../packages/validation/src/index';
import { plainTextDocument, type NoteDocument } from '../packages/editor-schema/src/index';

let postgres: StartedPostgreSqlContainer, minio: StartedTestContainer;
let owner: Pool;
let domain: ReturnType<typeof createDatabase>, auth: ReturnType<typeof createDatabase>;
let storage: ReturnType<typeof createS3Storage>, app: FastifyInstance;
let userA: string, userB: string, tokenA: string, tokenB: string;
let endpoint: string;
let processorDb: ReturnType<typeof createDatabase>, relayDb: ReturnType<typeof createDatabase>;
const processor = () => createAttachmentProcessor(processorDb.db);
const clean = async () => 'clean' as const;
const MB = 1024 * 1024;
const headers = (token = tokenA) => ({
  authorization: `Bearer ${token}`,
  origin: 'personalspace://',
});
const capture = () => createCaptureService(domain.db);
const service = (options = {}) => createAttachmentService(domain.db, storage, options);
async function note(userId = userA) {
  return (
    await capture().execute(
      userId,
      v7(),
      { op: 'capture', payload: { id: v7(), type: 'note', text: 'Photo note', plannedDate: null } },
      'attachment-test',
    )
  )[0]!;
}
function descriptor(parentId: string, bytes = Buffer.from('test document')): AttachmentDescriptor {
  return {
    id: v7(),
    parentId,
    filename: 'private-document.txt',
    size: bytes.length,
    mime: 'text/plain',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function open(input: AttachmentDescriptor) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/attachments/uploads',
    headers: headers(),
    payload: { descriptor: input, sessionId: null },
  });
  expect(response.statusCode, response.body).toBe(200);
  return attachmentUploadStateSchema.parse(response.json());
}
async function put(
  id: string,
  sessionId: string,
  number: number,
  bytes: Buffer,
): Promise<UploadedPart> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${id}/parts`,
    headers: headers(),
    payload: { sessionId, number },
  });
  expect(response.statusCode, response.body).toBe(200);
  const grant = attachmentUploadGrantSchema.parse(response.json());
  expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('300');
  expect(grant.headers['content-length']).toBe(String(bytes.length));
  const result = await fetch(grant.url, {
    method: 'PUT',
    headers: grant.headers,
    body: new Uint8Array(bytes),
  });
  expect(result.status, await result.text()).toBe(200);
  return { number, etag: result.headers.get('etag')! };
}
async function row(id: string) {
  return withUser(
    domain.db,
    userA,
    async (tx) => (await tx.select().from(attachments).where(eq(attachments.id, id)))[0]!,
    true,
  );
}
async function fixtureUser() {
  const id = v7();
  await owner.query(
    'INSERT INTO auth_user(id,name,email,age_confirmed,terms_accepted) VALUES ($1,$2,$3,true,true)',
    [id, 'Fixture', `${id}@example.test`],
  );
  return id;
}
beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  owner = new Pool({ connectionString: postgres.getConnectionUri() });
  await owner.query(await readFile(new URL('../infra/postgres/init.sql', import.meta.url), 'utf8'));
  await migrate(postgres.getConnectionUri());
  await migrate(postgres.getConnectionUri());
  const appUrl = new URL(postgres.getConnectionUri()),
    authUrl = new URL(postgres.getConnectionUri());
  appUrl.username = 'personalspace_app';
  appUrl.password = 'local_app_only';
  authUrl.username = 'personalspace_auth';
  authUrl.password = 'local_auth_only';
  domain = createDatabase(appUrl.href);
  auth = createDatabase(authUrl.href);
  await owner.query(
    "ALTER ROLE personalspace_attachment_processor LOGIN PASSWORD 'processor_test_only'",
  );
  const processorUrl = new URL(postgres.getConnectionUri());
  processorUrl.username = 'personalspace_attachment_processor';
  processorUrl.password = 'processor_test_only';
  processorDb = createDatabase(processorUrl.href);
  const relayUrl = new URL(postgres.getConnectionUri());
  relayUrl.username = 'personalspace_worker';
  relayUrl.password = 'local_worker_only';
  relayDb = createDatabase(relayUrl.href);
  const image = await GenericContainer.fromDockerfile(
    fileURLToPath(new URL('../infra/storage', import.meta.url)),
  )
    .withBuildkit()
    .build('personalspace-storage:2025-10-15', { deleteOnExit: false });
  minio = await image
    .withEnvironment({
      MINIO_ROOT_USER: 'integration_test',
      MINIO_ROOT_PASSWORD: 'integration_secret_only',
    })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  storage = createS3Storage(
    readStorageConfig({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: 'private-test-attachments',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'integration_test',
      S3_SECRET_ACCESS_KEY: 'integration_secret_only',
    })!,
  );
  await storage.setup();
  app = await createApp({
    db: domain.db,
    authDb: auth.db,
    storage,
    logger: false,
    ready: async () => {},
    config: {
      NODE_ENV: 'test',
      PORT: 4000,
      HOST: '127.0.0.1',
      API_URL: 'http://localhost:4000',
      WEB_URL: 'http://localhost:3000',
      DATABASE_URL: appUrl.href,
      AUTH_DATABASE_URL: authUrl.href,
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters',
    },
  });
  await app.ready();
  async function signup(email: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'personalspace://', 'sec-fetch-mode': 'cors' },
      payload: {
        name: 'Test',
        email,
        password: 'test-password-12345',
        ageConfirmed: true,
        termsAccepted: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string; user: { id: string } }>();
  }
  const a = await signup('attachments-a@example.test'),
    b = await signup('attachments-b@example.test');
  userA = a.user.id;
  tokenA = a.token;
  userB = b.user.id;
  tokenB = b.token;
}, 600000);
afterAll(async () => {
  await app?.close();
  storage?.close();
  await Promise.all([
    domain?.pool.end(),
    auth?.pool.end(),
    processorDb?.pool.end(),
    relayDb?.pool.end(),
    owner?.end(),
  ]);
  await minio?.stop();
  await postgres?.stop();
});

describe('note attachment references', () => {
  const document = (...ids: string[]): NoteDocument => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: ids.map((id) => ({ type: 'attachmentReference', attrs: { attachmentId: id } })),
      },
    ],
  });
  it('validates owner/type/registration and bounds references atomically without changing attachment metadata', async () => {
    const user = await fixtureUser(),
      foreignUser = await fixtureUser();
    const parent = await note(user),
      foreign = await note(foreignUser);
    const file = descriptor(parent.id),
      foreignFile = descriptor(foreign.id);
    await service().open(user, file, 'register');
    await service().open(foreignUser, foreignFile, 'register');
    for (const id of [foreignFile.id, v7(), parent.id])
      await expect(
        capture().execute(
          user,
          v7(),
          {
            op: 'note.updateContent',
            id: parent.id,
            baseVersion: parent.version,
            contentSchemaVersion: 1,
            contentJson: document(id),
          },
          'reference',
        ),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCE_NOT_FOUND' });
    await expect(
      capture().execute(
        user,
        v7(),
        {
          op: 'note.updateContent',
          id: parent.id,
          baseVersion: parent.version,
          contentSchemaVersion: 1,
          contentJson: document(...Array.from({ length: 101 }, () => v7())),
        },
        'limit',
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_ATTACHMENTS' });
    const result = await capture().execute(
      user,
      v7(),
      {
        op: 'note.updateContent',
        id: parent.id,
        baseVersion: parent.version,
        contentSchemaVersion: 1,
        contentJson: document(file.id, file.id),
      },
      'reference',
    );
    expect(result[0]!.contentJson).toEqual(document(file.id, file.id));
    expect(result[0]!.text).toBe('[[File]][[File]]');
    const page = await capture().pull(user, 0);
    expect(page.changes.find((item) => item.id === file.id)?.attachment?.filename).toBe(
      file.filename,
    );
    expect(JSON.stringify(result[0]!.contentJson)).not.toContain(file.filename);
    expect(JSON.stringify(result[0]!.contentJson)).not.toContain('storage');
  });
  it('preserves file identity through draft copies/history and allows purged placeholders without recreating files', async () => {
    const user = await fixtureUser(),
      parent = await note(user),
      file = descriptor(parent.id);
    await service().open(user, file, 'register');
    const [saved] = await capture().execute(
      user,
      v7(),
      {
        op: 'note.updateContent',
        id: parent.id,
        baseVersion: parent.version,
        contentSchemaVersion: 1,
        contentJson: document(file.id),
      },
      'save',
    );
    const history = await createNoteHistoryService(domain.db).list(user, parent.id);
    const snapshot = history.versions.find((item) => item.version === saved!.version)!;
    expect(snapshot.contentJson).toEqual(document(file.id));
    const [copy] = await capture().execute(
      user,
      v7(),
      {
        op: 'note.copyDraft',
        id: v7(),
        sourceId: parent.id,
        sourceBaseVersion: saved!.version,
        contentSchemaVersion: 1,
        contentJson: document(file.id),
      },
      'copy',
    );
    expect(copy!.contentJson).toEqual(document(file.id));
    expect(copy!.recoveredFromId).toBe(parent.id);
    const [without] = await capture().execute(
      user,
      v7(),
      {
        op: 'note.updateContent',
        id: parent.id,
        baseVersion: saved!.version,
        contentSchemaVersion: 1,
        contentJson: plainTextDocument('Removed only the label'),
      },
      'remove-label',
    );
    expect((await capture().pull(user, 0)).changes.some((item) => item.id === file.id)).toBe(true);
    await service().cancel(user, file.id, 'remove-file');
    const [restored] = await capture().execute(
      user,
      v7(),
      {
        op: 'note.restoreVersion',
        id: parent.id,
        baseVersion: without!.version,
        versionId: snapshot.id,
      },
      'restore',
    );
    expect(restored!.contentJson).toEqual(document(file.id));
    const page = await capture().pull(user, 0);
    expect(page.changes.some((item) => item.id === file.id)).toBe(false);
    expect(page.tombstones.some((item) => item.id === file.id)).toBe(true);
  });
  it('rejects invalid attachment IDs in checkpoints and draft copies without persisting either', async () => {
    const user = await fixtureUser(),
      parent = await note(user),
      id = v7();
    const contentJson = document(v7());
    await expect(
      capture().execute(
        user,
        v7(),
        {
          op: 'note.checkpoint',
          id: parent.id,
          baseVersion: parent.version,
          contentSchemaVersion: 1,
          contentJson,
          reason: 'session_end',
        },
        'checkpoint',
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCE_NOT_FOUND' });
    await expect(
      capture().execute(
        user,
        v7(),
        {
          op: 'note.copyDraft',
          id,
          sourceId: parent.id,
          sourceBaseVersion: parent.version,
          contentSchemaVersion: 1,
          contentJson,
        },
        'copy',
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCE_NOT_FOUND' });
    expect((await createNoteHistoryService(domain.db).list(user, parent.id)).versions).toHaveLength(
      1,
    );
    expect((await capture().pull(user, 0)).changes.map((item) => item.id)).toEqual([parent.id]);
  });
});

describe('private attachment uploads', () => {
  it('registers idempotent, owner-isolated metadata without changing the note or disclosing storage keys through sync', async () => {
    const parent = await note(),
      input = descriptor(parent.id);
    const first = await open(input),
      retry = await open(input);
    expect(retry).toEqual(first);
    const page = await capture().pull(userA, parent.version);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      id: input.id,
      type: 'attachment',
      attachment: { status: 'pending' },
    });
    expect(JSON.stringify(page.changes)).not.toContain('storageKey');
    const all = await capture().pull(userA, 0);
    expect(all.changes.find((item) => item.id === parent.id)!.version).toBe(parent.version);
    expect(await withUser(domain.db, userB, (tx) => tx.select().from(attachments), true)).toEqual(
      [],
    );
    expect(await domain.db.select().from(attachments)).toEqual([]);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments/uploads',
      headers: headers(),
      payload: { descriptor: { ...input, filename: 'changed.txt' } },
    });
    expect(changed.statusCode).toBe(409);
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments/uploads',
      headers: headers(tokenB),
      payload: { descriptor: { ...input, id: v7() } },
    });
    expect(foreign.statusCode).toBe(404);
    const session = first.status === 'uploading' ? first.session.id : '';
    for (const [path, payload] of [
      ['parts', { sessionId: session, number: 1 }],
      ['complete', { sessionId: session, parts: [{ number: 1, etag: 'fake' }] }],
      ['cancel', {}],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${input.id}/${path}`,
        headers: headers(tokenB),
        payload,
      });
      expect(response.statusCode, response.body).toBe(404);
    }
  });

  it('uploads a checksum-bound single part privately and reconciles lost completion responses exactly once', async () => {
    const parent = await note(),
      bytes = Buffer.from('private file content'),
      input = descriptor(parent.id, bytes);
    const initial = await open(input);
    if (initial.status !== 'uploading') throw new Error('Expected upload');
    const part = await put(input.id, initial.session.id, 1, bytes);
    const stored = await row(input.id);
    expect(stored.storageKey).not.toContain(input.filename);
    expect((await fetch(`${endpoint}/private-test-attachments/${stored.storageKey}`)).status).toBe(
      403,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${input.id}/complete`,
        headers: headers(),
        payload: { sessionId: initial.session.id, parts: [part] },
      });
      expect(response.json()).toEqual({ status: 'processing' });
    }
    expect(await open(input)).toEqual({ status: 'processing' });
    const events = await owner.query(
      "SELECT id FROM outbox_events WHERE type='attachments.process' AND payload->>'attachmentId'=$1",
      [input.id],
    );
    expect(events.rowCount).toBe(1);
    expect((await row(input.id)).status).toBe('processing');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/attachments/${input.id}/download`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects bytes that do not match the single-part SHA-256 declaration', async () => {
    const input = descriptor((await note()).id, Buffer.from('correct bytes'));
    const initial = await open(input);
    if (initial.status !== 'uploading') throw new Error('Expected upload');
    const grant = await service().part(userA, input.id, initial.session.id, 1);
    const response = await fetch(grant.url, {
      method: 'PUT',
      headers: grant.headers,
      body: Buffer.from('altered bytes'),
    });
    expect(response.status).toBe(400);
    await response.text();
    expect(await storage.head((await row(input.id)).storageKey)).toBeNull();
    expect((await row(input.id)).status).toBe('pending');
  });

  it('resumes multipart uploads from actual S3 parts and rejects incomplete or forged completion lists', async () => {
    const bytes = Buffer.alloc(11 * MB, 19),
      input = descriptor((await note()).id, bytes);
    const initial = await open(input);
    if (initial.status !== 'uploading') throw new Error('Expected upload');
    const first = await put(input.id, initial.session.id, 1, bytes.subarray(0, 5 * MB));
    const resumed = await open(input);
    expect(resumed).toMatchObject({ status: 'uploading', parts: [first] });
    await expect(
      service().complete(userA, input.id, initial.session.id, [first], 'test'),
    ).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    const second = await put(input.id, initial.session.id, 2, bytes.subarray(5 * MB, 10 * MB));
    const third = await put(input.id, initial.session.id, 3, bytes.subarray(10 * MB));
    await expect(
      service().complete(
        userA,
        input.id,
        initial.session.id,
        [first, second, { ...third, etag: 'forged' }],
        'test',
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    expect(
      await service().complete(userA, input.id, initial.session.id, [third, second, first], 'test'),
    ).toEqual({ status: 'processing' });
    expect((await storage.head((await row(input.id)).storageKey))!.size).toBe(bytes.length);
  });

  it('replaces expired multipart sessions and rejects stale grants while concurrent opens converge', async () => {
    const input = descriptor((await note()).id, Buffer.alloc(6 * MB));
    const states = await Promise.all([open(input), open(input), open(input)]);
    expect(states[1]).toEqual(states[0]);
    expect(states[2]).toEqual(states[0]);
    const old = await row(input.id);
    await storage.abort(old.storageKey, old.uploadId!);
    const resumed = await open(input);
    if (resumed.status !== 'uploading') throw new Error('Expected upload');
    expect(resumed.session.id).not.toBe(old.sessionId);
    expect(resumed.parts).toEqual([]);
    await expect(service().part(userA, input.id, old.sessionId, 1)).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_CHANGED',
    });
    await expect(service().part(userA, input.id, resumed.session.id, 3)).rejects.toMatchObject({
      code: 'INVALID_UPLOAD_PART',
    });
  });

  it('serializes quota checks and retains upload-rate accounting after cancellation', async () => {
    const user = await fixtureUser(),
      parent = await note(user);
    const bounded = service({ quotaBytes: 15, uploadsPerHour: 2 });
    const inputs = [descriptor(parent.id), descriptor(parent.id)];
    const results = await Promise.allSettled(
      inputs.map((input) => bounded.open(user, input, 'quota')),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'STORAGE_QUOTA_EXCEEDED' },
    });
    const index = results.findIndex((result) => result.status === 'fulfilled');
    await bounded.cancel(user, inputs[index]!.id, 'cancel');
    const second = descriptor(parent.id);
    await bounded.open(user, second, 'second');
    await bounded.cancel(user, second.id, 'cancel');
    await expect(bounded.open(user, descriptor(parent.id), 'third')).rejects.toMatchObject({
      code: 'UPLOAD_RATE_LIMITED',
    });
  });

  it('cascades note Trash/restore/purge, scrubs retry metadata and durably removes the private object', async () => {
    const parent = await note(),
      bytes = Buffer.from('erase me'),
      input = descriptor(parent.id, bytes);
    const initial = await open(input);
    if (initial.status !== 'uploading') throw new Error('Expected upload');
    await put(input.id, initial.session.id, 1, bytes);
    await open(input);
    const original = await row(input.id);
    const key = v7();
    const trashed = await capture().execute(
      userA,
      key,
      { op: 'note.delete', id: parent.id, baseVersion: parent.version },
      'trash',
    );
    expect(trashed.map((item) => item.id).sort()).toEqual([parent.id, input.id].sort());
    expect(trashed.every((item) => item.deletedAt)).toBe(true);
    await expect(service().part(userA, input.id, initial.session.id, 1)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
    const restored = await capture().execute(
      userA,
      v7(),
      { op: 'note.restore', id: parent.id, baseVersion: trashed[0]!.version },
      'restore',
    );
    expect(restored.every((item) => item.deletedAt === null)).toBe(true);
    expect(restored).toHaveLength(2);
    const again = await capture().execute(
      userA,
      v7(),
      { op: 'note.delete', id: parent.id, baseVersion: restored[0]!.version },
      'trash',
    );
    await capture().execute(
      userA,
      v7(),
      { op: 'note.purge', id: parent.id, baseVersion: again[0]!.version },
      'purge',
    );
    expect(await row(input.id)).toBeUndefined();
    const page = await capture().pull(userA, again[0]!.version);
    expect(page.tombstones.map((item) => item.id).sort()).toEqual([parent.id, input.id].sort());
    expect(
      await capture().execute(
        userA,
        key,
        { op: 'note.delete', id: parent.id, baseVersion: parent.version },
        'replay',
      ),
    ).toEqual([]);
    const cleanup = await owner.query(
      "SELECT payload FROM outbox_events WHERE type='attachments.cleanup' AND payload->>'key'=$1",
      [original.storageKey],
    );
    const payload = cleanup.rows[0]!.payload;
    await expect(cleanAttachment(storage, userA, payload)).rejects.toThrow('not due');
    await cleanAttachment(storage, userA, { ...payload, notBefore: 0 });
    await cleanAttachment(storage, userA, { ...payload, notBefore: 0 });
    expect(await storage.head(original.storageKey)).toBeNull();
  });

  it('cancels multipart uploads idempotently, protects tombstones, and validates cleanup ownership', async () => {
    const parent = await note(),
      input = descriptor(parent.id, Buffer.alloc(6 * MB));
    await open(input);
    const original = await row(input.id);
    expect(await service().cancel(userA, input.id, 'cancel')).toEqual({ cancelled: true });
    expect(await service().cancel(userA, input.id, 'retry')).toEqual({ cancelled: true });
    await expect(service().open(userA, input, 'reopen')).rejects.toMatchObject({
      code: 'ID_UNAVAILABLE',
    });
    const cleanup = { key: original.storageKey, uploadId: original.uploadId, notBefore: 0 };
    await expect(cleanAttachment(storage, userB, cleanup)).rejects.toThrow('owner');
    expect(await storage.parts(original.storageKey, original.uploadId!)).not.toBeNull();
    await cleanAttachment(storage, userA, cleanup);
    expect(await storage.parts(original.storageKey, original.uploadId!)).toBeNull();
    expect(
      (await capture().pull(userA, 0)).changes.find((item) => item.id === parent.id)!.version,
    ).toBe(parent.version);
  });

  it('erases cancelled attachment metadata from earlier note command responses', async () => {
    const parent = await note(),
      input = descriptor(parent.id);
    await open(input);
    const deleted = await capture().execute(
      userA,
      v7(),
      { op: 'note.delete', id: parent.id, baseVersion: parent.version },
      'trash',
    );
    const key = v7();
    const command = {
      op: 'note.restore' as const,
      id: parent.id,
      baseVersion: deleted[0]!.version,
    };
    const restored = await capture().execute(userA, key, command, 'restore');
    expect(restored.map((item) => item.id)).toContain(input.id);
    await service().cancel(userA, input.id, 'cancel');
    const replay = await capture().execute(userA, key, command, 'replay');
    expect(replay.map((item) => item.id)).toEqual([parent.id]);
    expect((await capture().pull(userA, 0)).changes.some((item) => item.id === input.id)).toBe(
      false,
    );
  });

  it('performs object-storage I/O outside the per-user row-sync lock', async () => {
    const parent = await note(),
      input = descriptor(parent.id);
    const unlocked = createAttachmentService(domain.db, {
      ...storage,
      head: async (key) => {
        await capture().execute(
          userA,
          v7(),
          {
            op: 'note.edit',
            id: parent.id,
            baseVersion: parent.version,
            text: 'Edited while opening upload',
          },
          'concurrent',
        );
        return storage.head(key);
      },
    });
    expect((await unlocked.open(userA, input, 'open')).status).toBe('uploading');
  });
});

async function uploaded(
  bytes = Buffer.from('scanned document'),
  mime: AttachmentDescriptor['mime'] = 'text/plain',
) {
  const parent = await note(),
    input = { ...descriptor(parent.id, bytes), mime };
  const initial = await open(input);
  if (initial.status !== 'uploading') throw new Error('Expected upload');
  await put(input.id, initial.session.id, 1, bytes);
  await open(input);
  return { parent, input, bytes };
}
const download = (id: string, token = tokenA, variant = 'file') =>
  app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${id}/download`,
    headers: headers(token),
    payload: { variant },
  });

describe('attachment processing and download', () => {
  it('reserves offline removal IDs before registration so a delayed upload cannot resurrect them', async () => {
    const input = descriptor((await note()).id);
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${input.id}/remove`,
        headers: headers(),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await expect(service().open(userA, input, 'delayed-open')).rejects.toMatchObject({
      code: 'ID_UNAVAILABLE',
    });
    expect((await capture().pull(userA, 0)).tombstones.map((item) => item.id)).toContain(input.id);
  });

  it('removes a ready file independently of its note and blocks new download grants', async () => {
    const { parent, input } = await uploaded();
    await processAttachment(processor(), storage, clean, userA, input.id);
    const ready = await row(input.id);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${input.id}/remove`,
      headers: headers(tokenB),
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${input.id}/remove`,
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await download(input.id)).statusCode).toBe(404);
    expect(
      (await capture().pull(userA, 0)).changes.find((item) => item.id === parent.id)!.version,
    ).toBe(parent.version);
    const events = await owner.query(
      "SELECT payload FROM outbox_events WHERE type='attachments.cleanup' AND payload->>'key'=$1",
      [ready.processedKey],
    );
    expect(events.rowCount).toBe(1);
    await cleanAttachment(storage, userA, { ...events.rows[0]!.payload, notBefore: 0 });
    expect(await storage.head(ready.processedKey!)).toBeNull();
  });
  it('scopes the processor to attachment metadata and hides pending downloads', async () => {
    const { input } = await uploaded();
    expect(await processor().claim(userB, input.id)).toBeNull();
    expect(await processorDb.db.select().from(attachments)).toEqual([]);
    await expect(processorDb.pool.query('SELECT * FROM notes')).rejects.toThrow(
      'permission denied',
    );
    await expect(processorDb.pool.query('SELECT * FROM auth_user')).rejects.toThrow(
      'permission denied',
    );
    await expect(processorDb.pool.query('DELETE FROM attachments')).rejects.toThrow(
      'permission denied',
    );
    expect((await download(input.id)).statusCode).toBe(409);
    expect((await download(input.id, tokenB)).statusCode).toBe(404);
  });

  it('releases sanitized images and private short-lived downloads, then purges every artifact', async () => {
    const bytes = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#3467a1' },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: 'private author' } })
      .toBuffer();
    const { parent, input } = await uploaded(bytes, 'image/jpeg');
    await processAttachment(processor(), storage, clean, userA, input.id);
    const ready = await row(input.id);
    expect(ready.status).toBe('ready');
    expect(ready.processedKey).not.toBe(ready.storageKey);
    expect(ready.processedMime).toBe('image/webp');
    const response = await download(input.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const grant = response.json<{ url: string; sha256: string; size: number }>();
    expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('60');
    const full = await fetch(grant.url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/webp');
    expect(full.headers.get('content-disposition')).toContain('attachment;');
    const content = Buffer.from(await full.arrayBuffer());
    expect(createHash('sha256').update(content).digest('hex')).toBe(grant.sha256);
    expect(content.length).toBe(grant.size);
    expect((await sharp(content).metadata()).exif).toBeUndefined();
    const thumb = await download(input.id, tokenA, 'thumbnail');
    expect(thumb.statusCode).toBe(200);
    const small = Buffer.from(await (await fetch(thumb.json().url)).arrayBuffer());
    expect((await sharp(small).metadata()).width).toBeLessThanOrEqual(320);
    expect((await fetch(`${endpoint}/private-test-attachments/${ready.processedKey}`)).status).toBe(
      403,
    );
    await storage.write(ready.storageKey, Buffer.from('late upload overwrite'), 'text/plain');
    expect(await storage.read(ready.processedKey!, MB)).toEqual(content);
    await processAttachment(processor(), storage, clean, userA, input.id);
    expect((await row(input.id)).version).toBe(ready.version);
    const page = await capture().pull(userA, parent.version);
    expect(page.changes.find((item) => item.id === input.id)?.attachment).toMatchObject({
      status: 'ready',
      hasThumbnail: true,
    });
    expect(JSON.stringify(page)).not.toContain(ready.processedKey);
    expect(
      (await capture().pull(userA, 0)).changes.find((item) => item.id === parent.id)!.version,
    ).toBe(parent.version);
    const trashed = await capture().execute(
      userA,
      v7(),
      { op: 'note.delete', id: parent.id, baseVersion: parent.version },
      'trash',
    );
    expect((await download(input.id)).statusCode).toBe(404);
    await capture().execute(
      userA,
      v7(),
      { op: 'note.purge', id: parent.id, baseVersion: trashed[0]!.version },
      'purge',
    );
    for (const key of [ready.storageKey, ready.processedKey, ready.thumbnailKey]) {
      const events = await owner.query(
        "SELECT payload FROM outbox_events WHERE type='attachments.cleanup' AND payload->>'key'=$1",
        [key],
      );
      expect(events.rowCount).toBeGreaterThan(0);
      await cleanAttachment(storage, userA, { ...events.rows[0]!.payload, notBefore: 0 });
      expect(await storage.head(key!)).toBeNull();
    }
  });

  it('rejects integrity failures, mismatched MIME and infected files without granting downloads', async () => {
    const corrupt = await uploaded();
    const raw = await row(corrupt.input.id);
    await storage.write(raw.storageKey, Buffer.alloc(corrupt.bytes.length, 120), 'text/plain');
    await processAttachment(processor(), storage, clean, userA, corrupt.input.id);
    expect(await row(corrupt.input.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'integrity',
    });
    const wrong = await uploaded(Buffer.from('%PDF-1.7\nprivate file'), 'image/jpeg');
    await processAttachment(processor(), storage, clean, userA, wrong.input.id);
    expect(await row(wrong.input.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'type',
    });
    const infected = await uploaded();
    await processAttachment(processor(), storage, async () => 'infected', userA, infected.input.id);
    expect(await row(infected.input.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'malware',
    });
    for (const id of [corrupt.input.id, wrong.input.id, infected.input.id])
      expect((await download(id)).statusCode).toBe(409);
  });

  it('retries scanner outages without releasing files and cleans up abandoned output reservations', async () => {
    const { input, bytes } = await uploaded();
    await expect(
      processAttachment(
        processor(),
        storage,
        async () => {
          throw new Error('offline');
        },
        userA,
        input.id,
      ),
    ).rejects.toThrow('unavailable');
    const abandoned = await row(input.id);
    expect(abandoned.status).toBe('processing');
    expect(abandoned.processingToken).toBeNull();
    expect((await download(input.id)).statusCode).toBe(409);
    await processAttachment(processor(), storage, clean, userA, input.id);
    const ready = await row(input.id);
    expect(ready.processedKey).not.toBe(abandoned.processedKey);
    expect(await storage.read(ready.processedKey!, MB)).toEqual(bytes);
    expect((await download(input.id, tokenA, 'thumbnail')).statusCode).toBe(404);
    const cleanup = await owner.query(
      "SELECT id FROM outbox_events WHERE type='attachments.cleanup' AND payload->>'key'=$1",
      [abandoned.processedKey],
    );
    expect(cleanup.rowCount).toBe(1);
  });

  it('does not resurrect cancellation during processing and reserves cleanup before writes', async () => {
    const { input } = await uploaded();
    let cancelled: Awaited<ReturnType<typeof row>>;
    await processAttachment(
      processor(),
      storage,
      async () => {
        cancelled = await row(input.id);
        await service().cancel(userA, input.id, 'cancel-during-scan');
        return 'clean';
      },
      userA,
      input.id,
    );
    expect(await row(input.id)).toBeUndefined();
    expect((await download(input.id)).statusCode).toBe(404);
    const events = await owner.query(
      "SELECT payload FROM outbox_events WHERE type='attachments.cleanup' AND payload->>'key'=$1",
      [cancelled!.processedKey],
    );
    expect(events.rowCount).toBe(1);
    await cleanAttachment(storage, userA, { ...events.rows[0]!.payload, notBefore: 0 });
    expect(await storage.head(cancelled!.processedKey!)).toBeNull();
    await processAttachment(processor(), storage, clean, userA, input.id);
  });

  it('recovers expired processing leases and prevents stale completion', async () => {
    const { input } = await uploaded();
    const first = await processor().claim(userA, input.id);
    await expect(processor().claim(userA, input.id)).rejects.toMatchObject({
      code: 'PROCESSING_BUSY',
    });
    await owner.query(
      "UPDATE attachments SET processing_lease_until=now()-interval '1 second' WHERE id=$1",
      [input.id],
    );
    const next = await processor().claim(userA, input.id);
    expect(next!.processedKey).not.toBe(first!.processedKey);
    expect(
      await processor().finish(userA, input.id, first!.processingToken!, {
        status: 'rejected',
        reason: 'type',
      }),
    ).toBe(false);
    expect((await row(input.id)).status).toBe('processing');
    await processor().release(userA, input.id, next!.processingToken!);
    await processAttachment(processor(), storage, clean, userA, input.id);
    expect((await row(input.id)).status).toBe('ready');
  });

  it('includes processed file and thumbnail sizes in quota accounting before release', async () => {
    const user = await fixtureUser(),
      parent = await note(user);
    const bytes = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#3467a1' },
    })
      .jpeg()
      .toBuffer();
    const input = { ...descriptor(parent.id, bytes), mime: 'image/jpeg' as const };
    await service().open(user, input, 'quota-upload');
    const raw = (
      await withUser(processorDb.db, user, (tx) => tx.select().from(attachments), true)
    )[0]!;
    await storage.write(raw.storageKey, bytes, 'application/octet-stream');
    await service().open(user, input, 'complete');
    const bounded = createAttachmentProcessor(processorDb.db, { quotaBytes: bytes.length });
    await processAttachment(bounded, storage, clean, user, input.id);
    const result = (
      await withUser(processorDb.db, user, (tx) => tx.select().from(attachments), true)
    )[0]!;
    expect(result).toMatchObject({ status: 'rejected', rejectionReason: 'quota' });
    await expect(service().download(user, input.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_READY',
    });
  });

  it('delivers the durable processing event through BullMQ to the isolated processor role', async () => {
    const redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    const connection = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
      maxRetriesPerRequest: null,
    });
    const queue = new Queue('processing-integration', { connection });
    const events = new QueueEvents('processing-integration', { connection });
    const worker = new Worker(
      'processing-integration',
      async (job) => {
        await processAttachment(
          processor(),
          storage,
          clean,
          job.data.userId,
          job.data.payload.attachmentId,
        );
      },
      { connection, concurrency: 1 },
    );
    try {
      await events.waitUntilReady();
      const { input } = await uploaded();
      const event = await owner.query(
        "SELECT id FROM outbox_events WHERE type='attachments.process' AND payload->>'attachmentId'=$1",
        [input.id],
      );
      await relayAttachmentProcessing(relayDb.db, queue);
      await relayAttachmentProcessing(relayDb.db, queue);
      const job = await queue.getJob(event.rows[0]!.id);
      expect(job).not.toBeNull();
      await job!.waitUntilFinished(events, 20000);
      expect((await row(input.id)).status).toBe('ready');
      expect((await download(input.id)).statusCode).toBe(200);
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
      await connection.quit();
      await redisContainer.stop();
    }
  }, 60000);
});
