import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { v7 } from 'uuid';
import { createDatabase } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import { cleanupTrash, createCaptureService } from '../packages/domain/src/index';
import type { Command } from '../packages/validation/src/index';

let container: StartedPostgreSqlContainer;
let owner: Pool;
let app: ReturnType<typeof createDatabase>, maintenance: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  owner = new Pool({ connectionString: url });
  await owner.query(await readFile(new URL('../infra/postgres/init.sql', import.meta.url), 'utf8'));
  await migrate(url);
  const connection = (role: string, password: string) => {
    const parsed = new URL(url);
    parsed.username = role;
    parsed.password = password;
    return createDatabase(parsed.href);
  };
  app = connection('personalspace_app', 'local_app_only');
  maintenance = connection('personalspace_maintenance', 'local_maintenance_only');
});
afterAll(async () => {
  await Promise.all([app?.pool.end(), maintenance?.pool.end(), owner?.end()]);
  await container?.stop();
});
async function user() {
  const id = v7();
  await owner.query(
    'INSERT INTO auth_user(id,name,email,age_confirmed,terms_accepted) VALUES ($1,$2,$3,true,true)',
    [id, 'Retention fixture', `${id}@example.test`],
  );
  return id;
}
const execute = (userId: string, command: Command, key = v7()) =>
  createCaptureService(app.db).execute(userId, key, command, 'retention-test');
async function capture(userId: string, type: 'note' | 'task' | 'inbox' = 'note') {
  return (
    await execute(userId, {
      op: 'capture',
      payload: { id: v7(), type, text: 'Private fixture', plannedDate: null },
    })
  )[0]!;
}
async function age(...ids: string[]) {
  await owner.query(
    "UPDATE entities SET deleted_at=now()-interval '31 days' WHERE id=ANY($1::uuid[])",
    [ids],
  );
}
async function attachment(userId: string, parentId: string, version: number) {
  const id = v7(),
    key = `u/${userId}/${id}/original`;
  await owner.query(
    "INSERT INTO entities(id,user_id,type,version) VALUES ($1,$2,'attachment',$3)",
    [id, userId, version],
  );
  await owner.query(
    `INSERT INTO attachments(id,user_id,parent_id,filename,declared_mime,size_bytes,sha256,storage_key,upload_id,version)
    VALUES ($1,$2,$3,'private.txt','text/plain',4,$4,$5,'multipart-fixture',$6)`,
    [id, userId, parentId, 'a'.repeat(64), key, version],
  );
  return { id, key };
}

it('purges aged content, attachments and history atomically while syncing affected references and retaining reservations', async () => {
  const account = await user(),
    foreign = await user();
  const inbox = await capture(account, 'inbox');
  const noteId = v7();
  await execute(account, {
    op: 'inbox.convert',
    id: inbox.id,
    targetId: noteId,
    targetType: 'note',
    baseVersion: inbox.version,
  });
  const note = (await createCaptureService(app.db).pull(account, 0)).changes.find(
    (r) => r.id === noteId,
  )!;
  const file = await attachment(account, note.id, note.version);
  const [project] = await execute(account, {
    op: 'project.create',
    id: v7(),
    name: 'References',
    color: '#3563A5',
  });
  await execute(account, {
    op: 'project.setNotes',
    id: project!.id,
    noteIds: [note.id],
    baseVersion: project!.version,
  });
  const [trashed] = await execute(account, {
    op: 'note.delete',
    id: note.id,
    baseVersion: note.version,
  });
  const recent = await capture(account),
    live = await capture(foreign);
  await execute(account, { op: 'note.delete', id: recent.id, baseVersion: recent.version });
  await age(note.id, file.id);
  const cursor = (await createCaptureService(app.db).pull(account, 0)).nextCursor;
  const started = Date.now();
  expect(await cleanupTrash(maintenance.db)).toBe(2);
  for (const [table, column, id] of [
    ['notes', 'id', note.id],
    ['note_versions', 'note_id', note.id],
    ['attachments', 'id', file.id],
    ['search_documents', 'entity_id', note.id],
  ]) {
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [id])).rowCount).toBe(0);
  }
  expect(
    (await owner.query('SELECT 1 FROM notes WHERE id=ANY($1::uuid[])', [[recent.id, live.id]]))
      .rowCount,
  ).toBe(2);
  const markers = (
    await owner.query('SELECT id,version,purged_at,tags FROM entities WHERE id=ANY($1::uuid[])', [
      [note.id, file.id],
    ])
  ).rows;
  expect(markers).toHaveLength(2);
  expect(new Set(markers.map((r) => r.version)).size).toBe(1);
  for (const marker of markers) {
    expect(Number(marker.version)).toBeGreaterThan(trashed!.version);
    expect(marker.purged_at).toBeInstanceOf(Date);
    expect(marker.tags).toEqual([]);
  }
  const cleanup = (
    await owner.query(
      "SELECT payload FROM outbox_events WHERE user_id=$1 AND type='attachments.cleanup'",
      [account],
    )
  ).rows;
  expect(cleanup).toHaveLength(1);
  expect(cleanup[0].payload).toMatchObject({ key: file.key, uploadId: 'multipart-fixture' });
  expect(cleanup[0].payload.notBefore).toBeGreaterThanOrEqual(started + 600000);
  const delta = await createCaptureService(app.db).pull(account, cursor);
  expect(delta.tombstones.map((r) => r.id).sort()).toEqual([note.id, file.id].sort());
  expect(delta.changes.find((r) => r.id === project!.id)?.relatedNoteIds).toEqual([]);
  expect(delta.changes.find((r) => r.id === inbox.id)?.version).toBe(delta.nextCursor);
  expect(
    (await owner.query('SELECT converted_entity_id FROM inbox_items WHERE id=$1', [inbox.id]))
      .rows[0].converted_entity_id,
  ).toBeNull();
  const responses = (
    await owner.query('SELECT response FROM idempotency_keys WHERE user_id=$1', [account])
  ).rows;
  expect(
    responses.flatMap((r) => r.response).some((r) => r.id === note.id || r.id === file.id),
  ).toBe(false);
  expect(
    (
      await owner.query(
        "SELECT 1 FROM audit_logs WHERE user_id=$1 AND action='maintenance.trashPurge'",
        [account],
      )
    ).rowCount,
  ).toBe(4);
  expect(await cleanupTrash(maintenance.db)).toBe(0);
});

it('keeps a task parent until all children reach retention, then erases their recurrence rules', async () => {
  const account = await user();
  const parent = await capture(account, 'task');
  await execute(account, {
    op: 'task.setRecurrence',
    id: parent.id,
    baseVersion: parent.version,
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
  });
  const [child] = await execute(account, {
    op: 'task.addSubtask',
    id: v7(),
    parentId: parent.id,
    text: 'Child',
  });
  const current = (await createCaptureService(app.db).pull(account, 0)).changes.find(
    (r) => r.id === parent.id,
  )!;
  await execute(account, { op: 'task.delete', id: parent.id, baseVersion: current.version });
  await age(parent.id);
  expect(await cleanupTrash(maintenance.db)).toBe(0);
  expect((await owner.query('SELECT 1 FROM tasks WHERE id=$1', [parent.id])).rowCount).toBe(1);
  await age(child!.id);
  expect(await cleanupTrash(maintenance.db)).toBe(2);
  expect((await owner.query('SELECT 1 FROM tasks WHERE user_id=$1', [account])).rowCount).toBe(0);
  expect(
    (await owner.query('SELECT 1 FROM recurrence_rules WHERE user_id=$1', [account])).rowCount,
  ).toBe(0);
});

it('rechecks Trash after waiting for a concurrent restore to release the account lock', async () => {
  const account = await user(),
    note = await capture(account);
  await execute(account, { op: 'note.delete', id: note.id, baseVersion: note.version });
  await age(note.id);
  const connection = await owner.connect();
  let pending: Promise<number> | undefined;
  try {
    await connection.query('BEGIN');
    const state = await connection.query(
      'UPDATE user_sync_state SET version=version+1 WHERE user_id=$1 RETURNING version',
      [account],
    );
    pending = cleanupTrash(maintenance.db);
    await vi.waitFor(async () => {
      const waiting = await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE usename='personalspace_maintenance' AND wait_event_type='Lock' AND query LIKE '%user_sync_state%'",
      );
      expect(waiting.rowCount).toBeGreaterThan(0);
    });
    for (const table of ['notes', 'entities'])
      await connection.query(`UPDATE ${table} SET deleted_at=NULL,version=$2 WHERE id=$1`, [
        note.id,
        state.rows[0].version,
      ]);
    await connection.query('COMMIT');
    expect(await pending).toBe(0);
    expect(
      (await owner.query('SELECT deleted_at FROM notes WHERE id=$1', [note.id])).rows[0].deleted_at,
    ).toBeNull();
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
    await pending?.catch(() => {});
  }
});

it('rolls back every purge side effect after a failure and deduplicates concurrent retries', async () => {
  const account = await user(),
    note = await capture(account);
  const file = await attachment(account, note.id, note.version);
  await execute(account, { op: 'note.delete', id: note.id, baseVersion: note.version });
  await age(note.id);
  const before = (
    await owner.query('SELECT version FROM user_sync_state WHERE user_id=$1', [account])
  ).rows[0].version;
  await owner.query(`CREATE FUNCTION fail_retention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='maintenance.trashPurge' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_retention_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_retention_audit()`);
  try {
    await expect(cleanupTrash(maintenance.db)).rejects.toThrow();
    expect(
      (await owner.query('SELECT version FROM user_sync_state WHERE user_id=$1', [account])).rows[0]
        .version,
    ).toBe(before);
    expect((await owner.query('SELECT 1 FROM notes WHERE id=$1', [note.id])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM attachments WHERE id=$1', [file.id])).rowCount).toBe(
      1,
    );
    expect(
      (await owner.query('SELECT purged_at FROM entities WHERE id=$1', [note.id])).rows[0]
        .purged_at,
    ).toBeNull();
    expect(
      (
        await owner.query(
          "SELECT 1 FROM outbox_events WHERE user_id=$1 AND type='attachments.cleanup'",
          [account],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await owner.query(
      'DROP TRIGGER fail_retention_audit ON audit_logs; DROP FUNCTION fail_retention_audit()',
    );
  }
  const counts = await Promise.all([cleanupTrash(maintenance.db), cleanupTrash(maintenance.db)]);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
  expect(
    (
      await owner.query(
        "SELECT 1 FROM outbox_events WHERE user_id=$1 AND type='attachments.cleanup'",
        [account],
      )
    ).rowCount,
  ).toBe(1);
});

it('cannot write account balances or read authentication secrets through the maintenance role', async () => {
  await expect(
    maintenance.pool.query('UPDATE finance_accounts SET cached_balance_minor=0'),
  ).rejects.toThrow(/permission denied/);
  await expect(maintenance.pool.query('SELECT password FROM auth_account')).rejects.toThrow(
    /permission denied/,
  );
});

it('clears aged inbox, reminder and learning resources while excluding accounts already being erased', async () => {
  const account = await user(),
    erasing = await user();
  const inbox = await capture(account, 'inbox');
  await execute(account, { op: 'inbox.delete', id: inbox.id, baseVersion: inbox.version });
  const [reminder] = await execute(account, {
    op: 'reminder.create',
    id: v7(),
    entityId: null,
    title: 'Reminder',
    remindDate: '2026-01-01',
    remindTime: '12:00',
    timeMode: 'fixed',
    timezone: 'UTC',
  });
  await execute(account, {
    op: 'reminder.delete',
    id: reminder!.id,
    baseVersion: reminder!.version,
  });
  const [resource] = await execute(account, {
    op: 'resource.save',
    id: v7(),
    url: null,
    title: 'Course',
    resourceType: 'course',
    source: 'manual',
    collectionId: null,
    externalId: null,
  });
  await execute(account, {
    op: 'resource.delete',
    id: resource!.id,
    baseVersion: resource!.version,
  });
  const note = await capture(erasing);
  await execute(erasing, { op: 'note.delete', id: note.id, baseVersion: note.version });
  await age(inbox.id, reminder!.id, resource!.id, note.id);
  await owner.query(
    "INSERT INTO deletion_requests(user_id,status,grace_ends_at,started_at) VALUES ($1,'processing',now(),now())",
    [erasing],
  );
  expect(await cleanupTrash(maintenance.db)).toBe(3);
  for (const table of ['inbox_items', 'reminders', 'learning_resources'])
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE user_id=$1`, [account])).rowCount).toBe(
      0,
    );
  expect((await owner.query('SELECT 1 FROM notes WHERE id=$1', [note.id])).rowCount).toBe(1);
});

it('makes progress across bounded pages without losing any reserved IDs', async () => {
  const account = await user();
  await owner.query('INSERT INTO user_sync_state(user_id,version) VALUES ($1,1)', [account]);
  await owner.query(
    `WITH inserted AS (
    INSERT INTO entities(id,user_id,type,version,deleted_at)
    SELECT gen_random_uuid(),$1,'note',1,now()-interval '31 days' FROM generate_series(1,501)
    RETURNING id,user_id,version,deleted_at
  ) INSERT INTO notes(id,user_id,version,deleted_at,title,content_text,content_json)
    SELECT id,user_id,version,deleted_at,'Batch','Batch','{"type":"doc","content":[]}'::jsonb FROM inserted`,
    [account],
  );
  expect(await cleanupTrash(maintenance.db)).toBe(500);
  expect((await owner.query('SELECT 1 FROM notes WHERE user_id=$1', [account])).rowCount).toBe(1);
  expect(await cleanupTrash(maintenance.db)).toBe(1);
  expect(
    (
      await owner.query('SELECT 1 FROM entities WHERE user_id=$1 AND purged_at IS NOT NULL', [
        account,
      ])
    ).rowCount,
  ).toBe(501);
  expect(await cleanupTrash(maintenance.db)).toBe(0);
});

it('does not let a page of older task parents starve their expired children', async () => {
  const account = await user();
  const parents = Array.from({ length: 500 }, () => v7());
  const children = Array.from({ length: 500 }, () => v7());
  await owner.query('INSERT INTO user_sync_state(user_id,version) VALUES ($1,1)', [account]);
  await owner.query(
    `INSERT INTO entities(id,user_id,type,version,deleted_at)
    SELECT id,$1,'task',1,now()-interval '32 days' FROM unnest($2::uuid[]) id`,
    [account, parents],
  );
  await owner.query(
    `INSERT INTO entities(id,user_id,type,version,deleted_at)
    SELECT id,$1,'task',1,now()-interval '31 days' FROM unnest($2::uuid[]) id`,
    [account, children],
  );
  await owner.query(
    `INSERT INTO tasks(id,user_id,title,version,deleted_at)
    SELECT id,user_id,'Parent',version,deleted_at FROM entities WHERE user_id=$1 AND id=ANY($2::uuid[])`,
    [account, parents],
  );
  await owner.query(
    `INSERT INTO tasks(id,user_id,title,version,deleted_at,parent_id)
    SELECT c.id,$1,'Child',1,now()-interval '31 days',c.parent FROM unnest($2::uuid[],$3::uuid[]) AS c(id,parent)`,
    [account, children, parents],
  );
  expect(await cleanupTrash(maintenance.db)).toBe(500);
  expect(await cleanupTrash(maintenance.db)).toBe(500);
  expect((await owner.query('SELECT 1 FROM tasks WHERE user_id=$1', [account])).rowCount).toBe(0);
});
