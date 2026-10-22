import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  backgroundSchedules,
  runBackgroundSchedules,
  reconcileBackgroundSchedules,
} from '../apps/worker/src/background-schedules';

let container: StartedTestContainer;
let connection: Redis;
let url: string;
beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  connection = new Redis(url, { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  connection?.disconnect();
  await container?.stop();
});

function inspectors(prefix: string) {
  return backgroundSchedules.map((schedule) => new Queue(schedule.queue, { connection, prefix }));
}

async function assertSchedules(queues: Queue[]) {
  await vi.waitFor(
    async () => {
      for (const [index, queue] of queues.entries()) {
        const definition = backgroundSchedules[index]!;
        const matches = (await queue.getRepeatableJobs()).filter(
          (job) => job.name === definition.name && job.pattern === definition.pattern && !job.id,
        );
        expect(matches).toHaveLength(1);
      }
    },
    { timeout: 15000, interval: 50 },
  );
}

it('registers every schedule before shutdown and preserves existing delayed occurrences', async () => {
  const prefix = randomUUID();
  const queues = inspectors(prefix);
  const stop = new AbortController();
  const log = vi.fn();
  const runs: Promise<void>[] = [];
  try {
    runs.push(runBackgroundSchedules(url, stop.signal, log, { prefix, intervalMs: 50 }));
    await assertSchedules(queues);
    const original = await Promise.all(queues.map((queue) => queue.getRepeatableJobs()));
    for (const queue of queues)
      await queue.add('unrelated', {}, { repeat: { pattern: '0 1 * * *' } });
    runs.push(runBackgroundSchedules(url, stop.signal, log, { prefix, intervalMs: 50 }));
    await assertSchedules(queues);
    for (const [index, queue] of queues.entries()) {
      const entries = await queue.getRepeatableJobs();
      expect(entries).toEqual(expect.arrayContaining(original[index]!));
      expect(entries).toHaveLength(2);
      const jobs = await queue.getDelayed();
      expect(jobs.some((job) => job.name === backgroundSchedules[index]!.name)).toBe(true);
    }
    expect(stop.signal.aborted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  } finally {
    stop.abort();
    await Promise.all(runs);
    await Promise.all(queues.map((queue) => queue.close()));
  }
});

it('deduplicates concurrent registration in fresh queues and preserves legacy and unrelated definitions', async () => {
  const queues = inspectors(randomUUID());
  const map = new Map(queues.map((queue) => [queue.name, queue]));
  const log = vi.fn();
  try {
    // An old installation already has its original metadata schedule.
    await queues[2]!.add('fetch-metadata', {}, { repeat: { pattern: '*/5 * * * *' } });
    const legacy = await queues[2]!.getRepeatableJobs();
    for (const queue of queues)
      await queue.add('unrelated', {}, { repeat: { pattern: '0 1 * * *' } });
    await Promise.all([
      reconcileBackgroundSchedules(map, log),
      reconcileBackgroundSchedules(map, log),
    ]);
    await assertSchedules(queues);
    expect(await queues[2]!.getRepeatableJobs()).toEqual(expect.arrayContaining(legacy));
    for (const queue of queues) {
      expect(await queue.getRepeatableJobs()).toHaveLength(2);
      const scheduled = (await queue.getDelayed()).find((job) => job.name !== 'unrelated');
      expect(scheduled).toBeDefined();
      if (queue.name === 'deletion' || queue.name === 'maintenance') {
        expect(scheduled!.opts).toMatchObject({
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
      }
    }
    expect(log).not.toHaveBeenCalled();
  } finally {
    await Promise.all(queues.map((queue) => queue.close()));
  }
});

it('retries startup and reconnect outages and restores lost Redis schedules without restarting', async () => {
  const sockets = new Set<Socket>();
  let available = false;
  const proxy = createServer((client) => {
    if (!available) {
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Proxy address unavailable');
  const prefix = randomUUID();
  const queues = inspectors(prefix);
  const stop = new AbortController();
  const log = vi.fn();
  const run = runBackgroundSchedules(`redis://127.0.0.1:${address.port}`, stop.signal, log, {
    prefix,
    intervalMs: 50,
  });
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('background_schedules_unavailable'));
    available = true;
    await assertSchedules(queues);
    available = false;
    for (const socket of sockets) socket.destroy();
    // This Redis instance belongs only to this test suite, never the application's server.
    await connection.flushdb();
    const failures = log.mock.calls.length;
    await vi.waitFor(() => expect(log.mock.calls.length).toBeGreaterThan(failures), {
      timeout: 10000,
    });
    available = true;
    await assertSchedules(queues);
    available = false;
    for (const socket of sockets) socket.destroy();
    stop.abort();
    await run;
    const stoppedLogs = log.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log).toHaveBeenCalledTimes(stoppedLogs);
    for (const queue of queues) expect(await queue.getRepeatableJobs()).toHaveLength(1);
  } finally {
    stop.abort();
    await run;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await Promise.all(queues.map((queue) => queue.close()));
  }
}, 30000);
