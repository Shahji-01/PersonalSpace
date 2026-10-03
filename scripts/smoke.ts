import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { v7 } from 'uuid';
import { z } from 'zod';
import { ApiError, createClient } from '../packages/api-client/src/index';
import {
  recordSchema,
  noteHistoryResponseSchema,
  pullResponseSchema,
} from '../packages/validation/src/index';

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
    const error = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(await response.json());
    throw new Error(
      `Smoke request failed: ${path} (${response.status}, ${error.success ? error.data.error.code : 'unknown'})`,
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
  const commandResponse = z.object({ data: z.array(recordSchema) });
  const task = commandResponse.parse(first).data[0]!;
  const repeating = commandResponse.parse(
    await request(
      '/api/v1/commands',
      {
        op: 'task.setRecurrence',
        id: task.id,
        baseVersion: task.version,
        recurrence: {
          frequency: 'DAILY',
          interval: 1,
          weekdays: [],
          lastDay: false,
          mode: 'fixed_schedule',
          anchorDate: '2026-10-02',
          anchorTime: null,
          timeMode: 'floating',
          timezone: 'Asia/Kolkata',
          endsOn: null,
          count: 2,
        },
      },
      account.token,
      v7(),
    ),
  ).data[0]!;
  const advanced = commandResponse.parse(
    await request(
      '/api/v1/commands',
      {
        op: 'task.complete',
        id: task.id,
        baseVersion: repeating.version,
      },
      account.token,
      v7(),
    ),
  ).data;
  if (advanced.filter((r) => r.id !== task.id && r.plannedDate === '2026-10-03').length !== 1)
    throw new Error('Recurring task did not create exactly one successor.');
  const note = commandResponse.parse(
    await request(
      '/api/v1/commands',
      {
        op: 'capture',
        payload: { id: v7(), type: 'note', text: 'Published smoke note', plannedDate: null },
      },
      account.token,
      v7(),
    ),
  ).data[0]!;
  await request(
    '/api/v1/commands',
    {
      op: 'note.checkpoint',
      id: note.id,
      baseVersion: note.version,
      contentJson: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Unfinished smoke draft' }] },
        ],
      },
      contentSchemaVersion: 1,
      reason: 'interval',
    },
    account.token,
    v7(),
  );
  const history = noteHistoryResponseSchema.parse(
    await request(`/api/v1/notes/${note.id}/versions`, undefined, account.token),
  );
  const checkpoint = history.versions.find((v) => v.reason === 'interval');
  const pulled = pullResponseSchema.parse(
    await request('/api/v1/sync/pull?cursor=0', undefined, account.token),
  );
  const published = pulled.changes.find((r) => r.id === note.id);
  if (!checkpoint || published?.text !== note.text || published.version !== note.version)
    throw new Error('Checkpoint did not preserve the published note.');
  const client = createClient(env.API_URL, () => account.token);
  const copy = commandResponse.parse(
    await request(
      '/api/v1/commands',
      {
        op: 'note.copyDraft',
        id: v7(),
        sourceId: note.id,
        sourceBaseVersion: note.version,
        contentJson: checkpoint.contentJson,
        contentSchemaVersion: 1,
      },
      account.token,
      v7(),
    ),
  ).data[0]!;
  if (copy.recoveredFromId !== note.id) throw new Error('Draft copy lost its source link.');
  // Age only this fixture's task deletion to exercise the real client/HTTP recovery contract.
  const taskToPurge = advanced.find((r) => r.id === task.id)!;
  const trashed = commandResponse.parse(
    await request(
      '/api/v1/commands',
      { op: 'task.delete', id: task.id, baseVersion: taskToPurge.version },
      account.token,
      v7(),
    ),
  ).data[0]!;
  await request(
    '/api/v1/commands',
    { op: 'task.purge', id: task.id, baseVersion: trashed.version },
    account.token,
    v7(),
  );
  await owner.query(
    "UPDATE entities SET purged_at=now()-interval '181 days' WHERE user_id=$1 AND id=$2",
    [userId, task.id],
  );
  let expired = false;
  try {
    await client.pull(0);
  } catch (error) {
    expired = error instanceof ApiError && error.status === 410 && error.code === 'RESYNC_REQUIRED';
  }
  if (!expired) throw new Error('Expired sync cursor was not rejected.');
  const recovered = await client.pull(0, true);
  if (
    !recovered.tombstones.some((r) => r.id === task.id) ||
    !recovered.changes.some((r) => r.id === copy.id)
  )
    throw new Error('Full recovery omitted a deletion marker or draft copy.');
  let delivered = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (Number(await redis.get(`sync-version:${userId}`)) >= recovered.nextCursor) {
      delivered = true;
      break;
    }
    await setTimeout(500);
  }
  if (!delivered) throw new Error('Outbox signal did not reach Redis. Start the worker.');
  await request('/api/auth/sign-out', {}, account.token);
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
console.log(
  'PASS: HTTP signup → capture/retry → recurrence/checkpoint/draft copy/full recovery → PostgreSQL outbox → BullMQ → Redis → sign-out and fixture cleanup.',
);
