import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { v7 } from 'uuid';
import { z } from 'zod';

const env = z
  .object({ API_URL: z.url(), MIGRATION_DATABASE_URL: z.url(), REDIS_URL: z.url() })
  .parse(process.env);
const databaseHost = new URL(env.MIGRATION_DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1'].includes(databaseHost))
  throw new Error('Smoke fixture cleanup is restricted to local databases.');
const owner = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('sync-signals', { connection: redis });
let userId: string | undefined;
async function request(
  path: string,
  body?: unknown,
  token?: string,
  key?: string,
): Promise<unknown> {
  const response = await fetch(`${env.API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'personalspace://',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = z.object({ code: z.string().optional() }).safeParse(await response.json());
    throw new Error(
      `Smoke request failed: ${path} (${response.status}, ${error.success ? error.data.code : 'unknown'})`,
    );
  }
  return response.json();
}
try {
  await request('/ready');
  const account = z.object({ token: z.string(), user: z.object({ id: z.string() }) }).parse(
    await request('/api/auth/sign-up/email', {
      name: 'Smoke Test',
      email: `smoke-${v7()}@example.test`,
      password: randomBytes(24).toString('hex'),
      ageConfirmed: true,
      termsAccepted: true,
    }),
  );
  userId = account.user.id;
  const payload = {
    op: 'capture',
    payload: { id: v7(), type: 'task', text: 'Synthetic local smoke test', plannedDate: null },
  };
  const key = v7();
  const first = await request('/api/v1/commands', payload, account.token, key);
  const replay = await request('/api/v1/commands', payload, account.token, key);
  if (JSON.stringify(first) !== JSON.stringify(replay))
    throw new Error('Idempotent replay differed.');
  let delivered = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await redis.get(`sync-version:${userId}`)) {
      delivered = true;
      break;
    }
    await setTimeout(500);
  }
  if (!delivered) throw new Error('Outbox signal did not reach Redis. Start the worker.');
  await request('/api/auth/sign-out', {}, account.token);
  console.log('PASS: HTTP signup → capture/retry → PostgreSQL outbox → BullMQ → Redis → sign-out.');
} finally {
  if (userId) {
    const jobs = await owner.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE user_id=$1',
      [userId],
    );
    for (const { id } of jobs.rows) await (await queue.getJob(id))?.remove();
    await owner.query('DELETE FROM auth_user WHERE id=$1', [userId]);
    await redis.del(`sync-version:${userId}`);
  }
  await queue.close();
  await redis.quit();
  await owner.end();
}
