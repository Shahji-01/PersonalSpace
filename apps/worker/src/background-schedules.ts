import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { scheduleAccountDeletion } from './deletion-schedule';
import { scheduleMaintenance } from './maintenance';

type ScheduleQueue = Pick<Queue, 'add' | 'getRepeatableJobs'>;
type ScheduleLog = (event: string) => void;

function repeat(name: string, pattern: string) {
  return (queue: ScheduleQueue) =>
    queue.add(
      name,
      {},
      {
        repeat: { pattern },
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
}

// Keep legacy names/options: changing repeat identities would duplicate existing jobs.
export const backgroundSchedules = [
  {
    queue: 'deletion',
    name: 'process-deletions',
    pattern: '0 * * * *',
    install: scheduleAccountDeletion,
  },
  { queue: 'maintenance', name: 'nightly', pattern: '0 2 * * *', install: scheduleMaintenance },
  {
    queue: 'metadata',
    name: 'fetch-metadata',
    pattern: '*/5 * * * *',
    install: repeat('fetch-metadata', '*/5 * * * *'),
  },
  {
    queue: 'notifications',
    name: 'deliver-reminders',
    pattern: '* * * * *',
    install: repeat('deliver-reminders', '* * * * *'),
  },
  {
    queue: 'email',
    name: 'process-emails',
    pattern: '* * * * *',
    install: repeat('process-emails', '* * * * *'),
  },
] as const;

export async function ensureBackgroundSchedule(
  queue: ScheduleQueue,
  schedule: (typeof backgroundSchedules)[number],
) {
  const existing = await queue.getRepeatableJobs();
  if (
    existing.some(
      (job) =>
        job.name === schedule.name &&
        job.pattern === schedule.pattern &&
        !job.id &&
        !job.tz &&
        !job.endDate &&
        !job.every,
    )
  )
    return;
  // BullMQ atomically deduplicates concurrent additions of the same repeat definition.
  // Do not re-add an existing definition: that can advance a delayed occurrence.
  await schedule.install(queue);
}

export async function reconcileBackgroundSchedules(
  queues: ReadonlyMap<string, ScheduleQueue>,
  log: ScheduleLog,
) {
  await Promise.all(
    backgroundSchedules.map(async (schedule) => {
      try {
        const queue = queues.get(schedule.queue);
        if (!queue) throw new Error('Schedule queue unavailable');
        await ensureBackgroundSchedule(queue, schedule);
      } catch {
        // Redis errors can include credentials/connection details. Log only the job category.
        log(`${schedule.queue}_schedule_failed`);
      }
    }),
  );
}

/** Independent of relay I/O; recreates missing schedules after Redis loss without a restart. */
export async function runBackgroundSchedules(
  redisUrl: string,
  signal: AbortSignal,
  log: ScheduleLog,
  options: { intervalMs?: number; prefix?: string } = {},
) {
  while (!signal.aborted) {
    // Workers need infinite retries; schedule producers need bounded attempts instead.
    // A fresh connection per pass also recovers a failed initial BullMQ initialization.
    const connection = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      commandTimeout: 5000,
      retryStrategy: () => null,
    });
    connection.on('error', () => {}); // The pass reports a sanitized error below.
    const queues = new Map<string, Queue>();
    const disconnect = () => connection.disconnect();
    signal.addEventListener('abort', disconnect, { once: true });
    try {
      await connection.connect();
      if (signal.aborted) return;
      for (const schedule of backgroundSchedules) {
        const queue = new Queue(schedule.queue, {
          connection,
          ...(options.prefix ? { prefix: options.prefix } : {}),
        });
        queue.on('error', () => {}); // Report once per failed schedule attempt.
        queues.set(schedule.queue, queue);
      }
      // BullMQ's lazy repeat getter assumes its queue client initialized successfully.
      // Await readiness explicitly so a failed initializer rejects this pass, not an
      // async Promise executor inside that getter (which would never settle).
      await Promise.all([...queues.values()].map((queue) => queue.waitUntilReady()));
      if (signal.aborted) return;
      await reconcileBackgroundSchedules(queues, (event) => {
        if (!signal.aborted) log(event);
      });
    } catch {
      if (!signal.aborted) log('background_schedules_unavailable');
    } finally {
      signal.removeEventListener('abort', disconnect);
      connection.disconnect();
      await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
    }
    if (!signal.aborted) {
      try {
        await delay(options.intervalMs ?? 60000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
