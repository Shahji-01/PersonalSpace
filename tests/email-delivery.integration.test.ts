import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../packages/db/src/migrate';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../packages/db/src/schema';
import {
  claimNextEmail,
  deliverClaimedEmail,
  processPendingEmails,
  ConsoleEmailProvider,
  UnavailableEmailProvider,
  EmailDeliveryError,
  type EmailProvider,
  type EmailEnvelope,
} from '../packages/domain/src/email';

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

beforeEach(async () => {
  await owner.query('DELETE FROM notification_log');
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

function deliveryDb() {
  return drizzle(maintenance, { schema });
}
async function readyEmail() {
  const id = await enqueue(await user());
  await owner.query(
    "UPDATE notification_log SET email_to='original@example.test',email_html='<p>Fixture body</p>' WHERE id=$1",
    [id],
  );
  return id;
}
async function row(id: string) {
  return (await owner.query('SELECT * FROM notification_log WHERE id=$1', [id])).rows[0];
}
function fakeProvider() {
  const accepted = new Map<string, string>();
  const sendEmail = vi.fn(async (email: EmailEnvelope) => {
    const providerId = accepted.get(email.idempotencyKey) ?? randomUUID();
    accepted.set(email.idempotencyKey, providerId);
    return { kind: 'accepted' as const, providerId };
  });
  return { fromAddress: 'sender@example.test', sendEmail, accepted };
}
async function claim(provider: EmailProvider) {
  const result = await claimNextEmail(deliveryDb(), provider);
  if (result?.kind !== 'claimed') throw new Error('Expected claim');
  return result.email;
}
async function expire(id: string) {
  await owner.query(
    "UPDATE notification_log SET email_lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
}

it('competing workers accept every message once and never reprocess accepted records', async () => {
  const ids = await Promise.all(Array.from({ length: 12 }, () => readyEmail()));
  const provider = fakeProvider();
  const counts = await Promise.all(
    Array.from({ length: 4 }, () => processPendingEmails(deliveryDb(), provider)),
  );
  expect(counts.reduce((a, b) => a + b, 0)).toBe(12);
  expect(provider.sendEmail).toHaveBeenCalledTimes(12);
  for (const id of ids) {
    expect(await row(id)).toMatchObject({
      status: 'accepted',
      email_attempts: 1,
      email_claim_id: null,
      sent_at: null,
    });
    expect((await row(id)).email_accepted_at).toBeInstanceOf(Date);
  }
  expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
});

it.each([false, true])(
  'recovers a crash with prior provider acceptance=%s and fences the old worker',
  async (submitted) => {
    const id = await readyEmail();
    const provider = fakeProvider();
    const abandoned = await claim(provider);
    const envelope: EmailEnvelope = {
      idempotencyKey: `personalspace/email/${id}`,
      to: abandoned.emailTo!,
      from: abandoned.emailFrom,
      subject: abandoned.title,
      text: abandoned.body!,
      html: abandoned.emailHtml,
    };
    if (submitted) await provider.sendEmail(envelope); // crash before persisting the receipt
    expect(await claimNextEmail(deliveryDb(), provider)).toBeNull(); // live lease
    await expire(id);
    const replacement = await claim({ ...provider, fromAddress: 'changed-config@example.test' });
    expect(replacement.emailClaimId).not.toBe(abandoned.emailClaimId);
    expect(replacement.emailFrom).toBe(abandoned.emailFrom);
    expect(await deliverClaimedEmail(deliveryDb(), provider, abandoned)).toBe(false);
    expect(await deliverClaimedEmail(deliveryDb(), provider, replacement)).toBe(true);
    expect(await deliverClaimedEmail(deliveryDb(), provider, abandoned)).toBe(false);
    expect(provider.accepted.size).toBe(1);
    for (const [message] of provider.sendEmail.mock.calls) expect(message).toEqual(envelope);
    expect(await row(id)).toMatchObject({
      status: 'accepted',
      email_attempts: 2,
      email_provider_id: provider.accepted.get(envelope.idempotencyKey),
    });
  },
);

it('backs off transient errors, respects Retry-After, and stops at the attempt bound', async () => {
  const id = await readyEmail();
  const provider: EmailProvider = {
    fromAddress: 'sender@example.test',
    sendEmail: vi.fn(async () => {
      throw new EmailDeliveryError('provider_rate_limited', true, 90_000);
    }),
  };
  for (let attempt = 1; attempt <= 8; attempt++) {
    const before = Date.now();
    expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
    const result = await row(id);
    expect(result).toMatchObject({
      status: attempt === 8 ? 'failed' : 'retrying',
      email_attempts: attempt,
      email_error_code: attempt === 8 ? 'attempts_exhausted' : 'provider_rate_limited',
      error: null,
    });
    expect(result.email_next_attempt_at.getTime() - before).toBeGreaterThanOrEqual(
      Math.max(90_000, Math.min(3_600_000, 30_000 * 2 ** (attempt - 1))) - 1000,
    );
    expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
    await owner.query('UPDATE notification_log SET email_next_attempt_at=now() WHERE id=$1', [id]);
  }
  expect(provider.sendEmail).toHaveBeenCalledTimes(8);
});

it('does not retry after the provider key window or when the message has expired', async () => {
  const id = await readyEmail();
  await owner.query(
    "UPDATE notification_log SET email_first_attempt_at=now()-interval '24 hours',email_attempts=1,status='retrying' WHERE id=$1",
    [id],
  );
  const expired = await readyEmail();
  await owner.query(
    "UPDATE notification_log SET email_expires_at=now()-interval '1 second' WHERE id=$1",
    [expired],
  );
  const legacy = await enqueue(await user());
  const provider = fakeProvider();
  expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
  expect(provider.sendEmail).not.toHaveBeenCalled();
  expect(await row(id)).toMatchObject({ status: 'failed', email_error_code: 'delivery_uncertain' });
  expect(await row(expired)).toMatchObject({ status: 'failed', email_error_code: 'expired' });
  expect(await row(legacy)).toMatchObject({
    status: 'failed',
    email_error_code: 'recipient_missing',
  });
});

it('records preview and unavailable outcomes without inventing send receipts', async () => {
  const preview = await readyEmail();
  expect(await processPendingEmails(deliveryDb(), new ConsoleEmailProvider())).toBe(0);
  expect(await row(preview)).toMatchObject({
    status: 'preview',
    sent_at: null,
    email_accepted_at: null,
    email_provider_id: null,
  });
  const unavailable = await readyEmail();
  expect(await processPendingEmails(deliveryDb(), new UnavailableEmailProvider())).toBe(0);
  expect(await row(unavailable)).toMatchObject({
    status: 'failed',
    email_error_code: 'configuration_missing',
    email_accepted_at: null,
  });
});

it('does not send a claimed email after account erasure begins', async () => {
  const id = await readyEmail();
  const provider = fakeProvider();
  const claimed = await claim(provider);
  await owner.query(
    "INSERT INTO deletion_requests(user_id,status,grace_ends_at,started_at) VALUES ($1,'processing',now(),now())",
    [claimed.userId],
  );
  expect(await deliverClaimedEmail(deliveryDb(), provider, claimed)).toBe(false);
  expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
  expect(provider.sendEmail).not.toHaveBeenCalled();
  await maintenance.query('DELETE FROM notification_log WHERE id=$1', [id]);
});

it('holds the erasure fence during provider submission and releases it on completion', async () => {
  const id = await readyEmail();
  const provider = fakeProvider();
  const claimed = await claim(provider);
  await owner.query(
    "INSERT INTO deletion_requests(user_id,status,grace_ends_at) VALUES ($1,'pending',now())",
    [claimed.userId],
  );
  let finish!: () => void;
  let started!: () => void;
  const submitting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  provider.sendEmail.mockImplementationOnce(async () => {
    started();
    await release;
    return { kind: 'accepted', providerId: randomUUID() };
  });
  const delivering = deliverClaimedEmail(deliveryDb(), provider, claimed);
  const eraser = await owner.connect();
  try {
    await submitting;
    await eraser.query("SET lock_timeout='100ms'");
    await expect(
      eraser.query(
        "UPDATE deletion_requests SET status='processing',started_at=now() WHERE user_id=$1",
        [claimed.userId],
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    finish();
    expect(await delivering).toBe(true);
    await eraser.query(
      "UPDATE deletion_requests SET status='processing',started_at=now() WHERE user_id=$1",
      [claimed.userId],
    );
    expect(await row(id)).toMatchObject({ status: 'accepted' });
  } finally {
    finish();
    await delivering;
    await eraser.query('RESET lock_timeout');
    eraser.release();
  }
});

it('does not resolve the recipient again after an account address changes or retain raw errors', async () => {
  const id = await readyEmail();
  const provider = fakeProvider();
  const claimed = await claim(provider);
  await owner.query("UPDATE auth_user SET email='changed@example.test' WHERE id=$1", [
    claimed.userId,
  ]);
  provider.sendEmail.mockRejectedValueOnce(
    new Error('Secret provider response and private@example.test'),
  );
  expect(await deliverClaimedEmail(deliveryDb(), provider, claimed)).toBe(false);
  expect(provider.sendEmail.mock.calls[0]![0].to).toBe('original@example.test');
  expect(await row(id)).toMatchObject({
    status: 'retrying',
    email_error_code: 'network_error',
    error: null,
  });
  await owner.query('UPDATE notification_log SET email_next_attempt_at=now() WHERE id=$1', [id]);
  provider.sendEmail.mockRejectedValueOnce(new EmailDeliveryError('provider_rejected', false));
  expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
  expect(await row(id)).toMatchObject({
    status: 'failed',
    email_error_code: 'provider_rejected',
    email_attempts: 2,
  });
  expect(await processPendingEmails(deliveryDb(), provider)).toBe(0);
  expect(provider.sendEmail).toHaveBeenCalledTimes(2);
});
