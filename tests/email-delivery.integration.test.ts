import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../packages/db/src/migrate';

let container: StartedPostgreSqlContainer;
let owner: Pool, app: Pool, maintenance: Pool, relay: Pool, auth: Pool;
let ownerUrl: string;
const pools: Pool[] = [];
const migrationName = '0044_email_delivery_state.sql';
const migrations = new URL('../packages/db/migrations/', import.meta.url);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  ownerUrl = container.getConnectionUri();
  owner = new Pool({ connectionString: ownerUrl });
  pools.push(owner);
  await owner.query(await readFile(new URL('../infra/postgres/init.sql', import.meta.url), 'utf8'));
  await migrate(ownerUrl);
  await migrate(ownerUrl);
  function role(name: string, password: string) {
    const url = new URL(ownerUrl);
    url.username = name;
    url.password = password;
    const pool = new Pool({ connectionString: url.href });
    pools.push(pool);
    return pool;
  }
  app = role('personalspace_app', 'local_app_only');
  maintenance = role('personalspace_maintenance', 'local_maintenance_only');
  relay = role('personalspace_worker', 'local_worker_only');
  auth = role('personalspace_auth', 'local_auth_only');
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await container?.stop();
});

async function user(db = owner) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO auth_user(id,name,email,age_confirmed,terms_accepted) VALUES ($1,$2,$3,true,true)',
    [id, 'Email fixture', `${id}@example.test`],
  );
  return id;
}

async function enqueue(userId: string, db = owner, status = 'pending') {
  const id = randomUUID();
  await db.query(
    `INSERT INTO notification_log(id,user_id,type,dedupe_key,title,body,channel,status)
    VALUES ($1::uuid,$2,'transactional',$1::text,'Fixture subject','Fixture body','email',$3)`,
    [id, userId, status],
  );
  return id;
}

it('applies fresh migrations repeatedly without claiming or accepting pending email', async () => {
  const id = await enqueue(await user());
  const result = await owner.query('SELECT * FROM notification_log WHERE id=$1', [id]);
  expect(result.rows[0]).toMatchObject({
    status: 'pending',
    email_attempts: 0,
    email_claim_id: null,
    email_provider_id: null,
    email_accepted_at: null,
    email_to: null,
  });
  expect(result.rows[0].email_next_attempt_at).toBeInstanceOf(Date);
});

it('upgrades a 0043 database while preserving historical sent and failed outcomes', async () => {
  await owner.query('CREATE DATABASE email_upgrade');
  const url = new URL(ownerUrl);
  url.pathname = '/email_upgrade';
  const upgrade = new Pool({ connectionString: url.href });
  pools.push(upgrade);
  await upgrade.query(
    'CREATE TABLE schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const name of (await readdir(migrations))
    .filter((file) => file.endsWith('.sql') && file < migrationName)
    .sort()) {
    const source = await readFile(new URL(name, migrations), 'utf8');
    await upgrade.query(source);
    await upgrade.query('INSERT INTO schema_migrations(name,hash) VALUES ($1,$2)', [
      name,
      createHash('sha256').update(source).digest('hex'),
    ]);
  }
  const account = await user(upgrade);
  const ids = await Promise.all(
    ['pending', 'sent', 'failed'].map((status) => enqueue(account, upgrade, status)),
  );
  await migrate(url.href);
  await migrate(url.href);
  const result = await upgrade.query(
    'SELECT id,status,email_attempts,email_claim_id,email_accepted_at FROM notification_log WHERE user_id=$1',
    [account],
  );
  for (const [index, status] of ['pending', 'sent', 'failed'].entries()) {
    expect(result.rows).toContainEqual({
      id: ids[index],
      status,
      email_attempts: 0,
      email_claim_id: null,
      email_accepted_at: null,
    });
  }
});

it('retains owner isolation and gives neither relay nor auth roles access to delivery records', async () => {
  const account = await user(),
    foreign = await user();
  const id = await enqueue(account),
    foreignId = await enqueue(foreign);
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)", [account]);
    const rows = await client.query('SELECT id FROM notification_log WHERE id=ANY($1::uuid[])', [
      [id, foreignId],
    ]);
    expect(rows.rows).toEqual([{ id }]);
    expect(
      (
        await client.query('UPDATE notification_log SET email_error_code=$1 WHERE id=$2', [
          'network_error',
          foreignId,
        ])
      ).rowCount,
    ).toBe(0);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await expect(relay.query('SELECT email_to FROM notification_log')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(auth.query('SELECT email_to FROM notification_log')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(maintenance.query('SELECT password FROM auth_account')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(maintenance.query('SELECT name FROM auth_user')).rejects.toMatchObject({
    code: '42501',
  });
});

it('validates claims and sanitized codes and freezes an attempted delivery envelope', async () => {
  const id = await enqueue(await user());
  await expect(
    owner.query("UPDATE notification_log SET status='processing' WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    owner.query('UPDATE notification_log SET email_attempts=-1 WHERE id=$1', [id]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    owner.query('UPDATE notification_log SET email_error_code=$2 WHERE id=$1', [
      id,
      'Raw provider body',
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    owner.query('UPDATE notification_log SET email_claim_id=$2 WHERE id=$1', [id, randomUUID()]),
  ).rejects.toMatchObject({ code: '23514' });
  await maintenance.query(
    `UPDATE notification_log SET status='processing',email_to='fixture@example.test',email_from='sender@example.test',
    email_attempts=1,email_first_attempt_at=now(),email_claim_id=$2,email_lease_expires_at=now()+interval '2 minutes' WHERE id=$1`,
    [id, randomUUID()],
  );
  await expect(
    maintenance.query('UPDATE notification_log SET body=$2 WHERE id=$1', [id, 'Replacement body']),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    maintenance.query('UPDATE notification_log SET email_first_attempt_at=NULL WHERE id=$1', [id]),
  ).rejects.toMatchObject({ code: '55000' });
  await maintenance.query(
    `UPDATE notification_log SET status='retrying',email_claim_id=NULL,email_lease_expires_at=NULL,
    email_error_code='network_error',email_next_attempt_at=now()+interval '1 minute' WHERE id=$1`,
    [id],
  );
  expect(
    (await owner.query('SELECT status,email_error_code FROM notification_log WHERE id=$1', [id]))
      .rows[0],
  ).toEqual({ status: 'retrying', email_error_code: 'network_error' });
});

it('keeps the account-erasure fence and erases delivery metadata with its notification', async () => {
  const account = await user();
  const id = await enqueue(account);
  await owner.query(
    "INSERT INTO deletion_requests(user_id,status,grace_ends_at,started_at) VALUES ($1,'processing',now(),now())",
    [account],
  );
  await expect(
    maintenance.query("UPDATE notification_log SET email_error_code='expired' WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: '55000' });
  await maintenance.query('DELETE FROM notification_log WHERE id=$1', [id]);
  expect((await owner.query('SELECT id FROM notification_log WHERE id=$1', [id])).rows).toEqual([]);
});
