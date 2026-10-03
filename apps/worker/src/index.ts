import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase, outboxEvents } from '@personalspace/db';
import { createS3Storage, readStorageConfig } from '@personalspace/storage';
import { cleanAttachment, cleanupEventSchema } from './attachment-cleanup';
import { createAttachmentProcessor } from '@personalspace/domain';
import { createClamScanner, readProcessorConfig } from './attachment-scanner';
import {
  processAttachment,
  processingEventSchema,
  relayAttachmentProcessing,
} from './attachment-processing';

const env = z.object({ WORKER_DATABASE_URL: z.url(), REDIS_URL: z.url() }).safeParse(process.env);
if (!env.success) throw new Error('WORKER_DATABASE_URL and REDIS_URL are required.');
const { db, pool } = createDatabase(env.data.WORKER_DATABASE_URL);
const redis = new Redis(env.data.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('sync-signals', { connection: redis });
const storageConfig = readStorageConfig(process.env);
const storage = storageConfig ? createS3Storage(storageConfig) : null;
const processorConfig = readProcessorConfig(process.env);
if (processorConfig && !storage) throw new Error('Attachment processing requires storage.');
const processorDb = processorConfig
  ? createDatabase(processorConfig.ATTACHMENT_DATABASE_URL)
  : null;
const processingQueue = processorDb
  ? new Queue('attachment-processing', { connection: redis })
  : null;
const processingWorker =
  processorDb && processorConfig && storage
    ? new Worker(
        'attachment-processing',
        async (job) => {
          const data = z
            .object({ userId: z.uuid(), payload: processingEventSchema })
            .parse(job.data);
          await processAttachment(
            createAttachmentProcessor(processorDb.db),
            storage,
            createClamScanner(processorConfig.CLAMAV_HOST, processorConfig.CLAMAV_PORT),
            data.userId,
            data.payload.attachmentId,
          );
        },
        { connection: redis, concurrency: 1 },
      )
    : null;
processingWorker?.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'attachment_processing_failed', jobId: job?.id })),
);
processingWorker?.on('error', () =>
  console.error(JSON.stringify({ event: 'attachment_processing_unavailable' })),
);
const fileQueue = storage ? new Queue('attachment-cleanup', { connection: redis }) : null;
const fileWorker = storage
  ? new Worker(
      'attachment-cleanup',
      async (job) => {
        const data = z.object({ userId: z.uuid(), payload: cleanupEventSchema }).parse(job.data);
        await cleanAttachment(storage, data.userId, data.payload);
      },
      { connection: redis, concurrency: 2 },
    )
  : null;
fileWorker?.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'attachment_cleanup_failed', jobId: job?.id })),
);
fileWorker?.on('error', () =>
  console.error(JSON.stringify({ event: 'attachment_cleanup_unavailable' })),
);
const worker = new Worker(
  'sync-signals',
  async (job) => {
    const data = z
      .object({ userId: z.uuid(), version: z.number().int().nonnegative() })
      .parse(job.data);
    // Out-of-order retries cannot move the cache watermark backwards.
    await redis.eval(
      "local old = tonumber(redis.call('GET', KEYS[1]) or '0'); if tonumber(ARGV[1]) > old then redis.call('SET', KEYS[1], ARGV[1], 'EX', 86400) end; return 1",
      1,
      `sync-version:${data.userId}`,
      data.version,
    );
  },
  { connection: redis },
);
worker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'job_failed', jobId: job?.id })),
);
worker.on('error', () => console.error(JSON.stringify({ event: 'worker_unavailable' })));
redis.on('error', () => console.error(JSON.stringify({ event: 'redis_unavailable' })));
let stopping = false;
async function relay() {
  // Independent relay attempts keep scanner/storage outages from blocking row-sync signals.
  if (processingQueue) {
    try {
      await relayAttachmentProcessing(db, processingQueue);
    } catch {
      console.error(JSON.stringify({ event: 'attachment_processing_relay_failed' }));
    }
  }
  if (fileQueue) {
    const cleanup = await db
      .select()
      .from(outboxEvents)
      .where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.type, 'attachments.cleanup')))
      .orderBy(outboxEvents.createdAt)
      .limit(100);
    for (const event of cleanup) {
      const payload = cleanupEventSchema.parse(event.payload);
      await fileQueue.add(
        'remove',
        { userId: event.userId, payload },
        {
          jobId: event.id,
          delay: Math.max(0, payload.notBefore - Date.now()),
          attempts: 12,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 7 * 86400 },
          removeOnFail: false,
        },
      );
      await db
        .update(outboxEvents)
        .set({ processedAt: new Date() })
        .where(eq(outboxEvents.id, event.id));
    }
  }
  const events = await db
    .select()
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.type, 'entities.changed')))
    .orderBy(outboxEvents.createdAt)
    .limit(100);
  for (const event of events) {
    const payload = z.object({ version: z.number().int().nonnegative() }).parse(event.payload);
    await queue.add(
      'changed',
      { userId: event.userId, version: payload.version },
      {
        jobId: event.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
    // Publish first, mark second. Crash between them replays the same BullMQ job ID.
    await db
      .update(outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(outboxEvents.id, event.id));
  }
}
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
try {
  while (!stopping) {
    try {
      await relay();
    } catch {
      console.error(JSON.stringify({ event: 'outbox_relay_failed' }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await processingWorker?.close();
  await processingQueue?.close();
  await processorDb?.pool.end();
  await fileWorker?.close();
  await fileQueue?.close();
  storage?.close();
  await worker.close();
  await queue.close();
  await redis.quit();
  await pool.end();
}
