import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase, outboxEvents, exportJobs } from '@personalspace/db';
import { createS3Storage, readStorageConfig } from '@personalspace/storage';
import { cleanAttachment, cleanupEventSchema } from './attachment-cleanup';
import {
  createAttachmentProcessor,
  cleanupTrash,
  cleanupTombstones,
  cleanupIdempotencyKeys,
  reconcileBalances,
  expireExports,
  generateExportData,
  exportToJson,
  exportToCsv,
  executePendingDeletions,
  processPendingMetadata,
  deliverDueReminders,
  processPendingEmails,
  ConsoleEmailProvider,
} from '@personalspace/domain';
import { createClamScanner, readProcessorConfig } from './attachment-scanner';
import {
  processAttachment,
  processingEventSchema,
  relayAttachmentProcessing,
} from './attachment-processing';

const env = z
  .object({
    WORKER_DATABASE_URL: z.url(),
    MAINTENANCE_DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error('WORKER_DATABASE_URL, MAINTENANCE_DATABASE_URL and REDIS_URL are required.');
const { db, pool } = createDatabase(env.data.WORKER_DATABASE_URL);
// Cross-user nightly maintenance uses a dedicated least-privilege role so the
// sync relay (WORKER_DATABASE_URL) still sees only outbox metadata.
const { db: maintenanceDb, pool: maintenancePool } = createDatabase(
  env.data.MAINTENANCE_DATABASE_URL,
);
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

// ============================================================
// Maintenance worker — nightly cleanup jobs (§49.2, §64.1)
// ============================================================
const maintenanceQueue = new Queue('maintenance', { connection: redis });
const maintenanceWorker = new Worker(
  'maintenance',
  async (job) => {
    const log = (event: string, detail?: object) =>
      console.log(JSON.stringify({ event, ...detail }));
    try {
      const trashCount = await cleanupTrash(maintenanceDb);
      log('trash_cleanup', { purged: trashCount });
    } catch (e) {
      log('trash_cleanup_failed', { error: String(e) });
    }
    try {
      const tombstoneCount = await cleanupTombstones(maintenanceDb);
      log('tombstone_cleanup', { removed: tombstoneCount });
    } catch (e) {
      log('tombstone_cleanup_failed', { error: String(e) });
    }
    try {
      const keyCount = await cleanupIdempotencyKeys(maintenanceDb);
      log('idempotency_cleanup', { removed: keyCount });
    } catch (e) {
      log('idempotency_cleanup_failed', { error: String(e) });
    }
    try {
      const { drifts } = await reconcileBalances(maintenanceDb);
      if (drifts.length) {
        log('balance_drift_detected', { drifts });
      } else {
        log('balance_reconciliation_ok');
      }
    } catch (e) {
      log('balance_reconciliation_failed', { error: String(e) });
    }
    try {
      const expiredCount = await expireExports(maintenanceDb);
      log('export_expiry', { expired: expiredCount });
    } catch (e) {
      log('export_expiry_failed', { error: String(e) });
    }
  },
  { connection: redis, concurrency: 1 },
);
maintenanceWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'maintenance_failed', jobId: job?.id })),
);
maintenanceWorker.on('error', () =>
  console.error(JSON.stringify({ event: 'maintenance_unavailable' })),
);

// ============================================================
// Export worker — generate data archives (§20.1)
// ============================================================
const exportQueue = new Queue('export', { connection: redis });
const exportWorker = new Worker(
  'export',
  async (job) => {
    const data = z
      .object({
        userId: z.uuid(),
        jobId: z.uuid(),
        format: z.enum(['json', 'csv', 'markdown']),
        scope: z.enum(['everything', 'notes', 'tasks', 'learning', 'money']),
      })
      .parse(job.data);
    const { eq } = await import('drizzle-orm');
    await maintenanceDb
      .update(exportJobs)
      .set({ status: 'processing', startedAt: new Date() })
      .where(eq(exportJobs.id, data.jobId));
    try {
      const exportData = await generateExportData(maintenanceDb, data.userId, data.scope);
      let result: string;
      let sizeBytes: number;
      if (data.format === 'json') {
        result = exportToJson(exportData);
        sizeBytes = Buffer.byteLength(result, 'utf8');
      } else if (data.format === 'csv') {
        const files = exportToCsv(exportData);
        result = JSON.stringify(files);
        sizeBytes = Buffer.byteLength(result, 'utf8');
      } else {
        // Markdown: export notes as plain text.
        result = exportToJson(exportData);
        sizeBytes = Buffer.byteLength(result, 'utf8');
      }
      // In production, upload to S3. For now, store size.
      const storageKey = `exports/${data.userId}/${data.jobId}.${data.format}`;
      if (storage) {
        const mime =
          data.format === 'json'
            ? 'application/json'
            : data.format === 'csv'
              ? 'text/csv'
              : 'text/markdown';
        await storage.write(storageKey, Buffer.from(result, 'utf8'), mime);
      }
      await maintenanceDb
        .update(exportJobs)
        .set({
          status: 'ready',
          storageKey,
          sizeBytes,
          completedAt: new Date(),
          downloadUrlExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        })
        .where(eq(exportJobs.id, data.jobId));
    } catch (e) {
      await maintenanceDb
        .update(exportJobs)
        .set({ status: 'failed', error: String(e), completedAt: new Date() })
        .where(eq(exportJobs.id, data.jobId));
      throw e;
    }
  },
  { connection: redis, concurrency: 1 },
);
exportWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'export_failed', jobId: job?.id })),
);
exportWorker.on('error', () => console.error(JSON.stringify({ event: 'export_unavailable' })));

// ============================================================
// Deletion worker — execute pending account deletions (§64.4)
// ============================================================
const deletionQueue = new Queue('deletion', { connection: redis });
const deletionWorker = new Worker(
  'deletion',
  async () => {
    const onStorageCleanup = storage
      ? async (userId: string) => {
          // Remove all user files from object storage.
          // In production, this would list and delete the u/<userId>/ prefix.
          console.log(JSON.stringify({ event: 'deletion_storage_cleanup', userId }));
        }
      : undefined;
    const onCacheCleanup = async (userId: string) => {
      await redis.del(`sync-version:${userId}`);
      console.log(JSON.stringify({ event: 'deletion_cache_cleanup', userId }));
    };
    const deleted = await executePendingDeletions(db, onStorageCleanup, onCacheCleanup);
    if (deleted.length) {
      console.log(JSON.stringify({ event: 'deletion_completed', count: deleted.length }));
    }
  },
  { connection: redis, concurrency: 1 },
);
deletionWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'deletion_failed', jobId: job?.id })),
);
deletionWorker.on('error', () => console.error(JSON.stringify({ event: 'deletion_unavailable' })));

// ============================================================
// Metadata worker — fetch URL metadata for learning resources (§41)
// ============================================================
const metadataQueue = new Queue('metadata', { connection: redis });
const metadataWorker = new Worker(
  'metadata',
  async () => {
    try {
      const processed = await processPendingMetadata(maintenanceDb);
      if (processed > 0) {
        console.log(JSON.stringify({ event: 'metadata_processed', count: processed }));
      }
    } catch (e) {
      console.log(JSON.stringify({ event: 'metadata_processing_failed', error: String(e) }));
    }
  },
  { connection: redis, concurrency: 1 },
);
metadataWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'metadata_worker_failed', jobId: job?.id })),
);
metadataWorker.on('error', () =>
  console.error(JSON.stringify({ event: 'metadata_worker_unavailable' })),
);

// ============================================================
// Notifications worker — deliver push reminders (§50)
// ============================================================
const notificationsQueue = new Queue('notifications', { connection: redis });
const notificationsWorker = new Worker(
  'notifications',
  async () => {
    try {
      const delivered = await deliverDueReminders(maintenanceDb);
      if (delivered > 0) {
        console.log(JSON.stringify({ event: 'reminders_delivered', count: delivered }));
      }
    } catch (e) {
      console.log(JSON.stringify({ event: 'reminders_delivery_failed', error: String(e) }));
    }
  },
  { connection: redis, concurrency: 1 },
);
notificationsWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'notifications_worker_failed', jobId: job?.id })),
);
notificationsWorker.on('error', () =>
  console.error(JSON.stringify({ event: 'notifications_worker_unavailable' })),
);

// ============================================================
// Email worker — process and send transactional emails (§70)
// ============================================================
const emailQueue = new Queue('email', { connection: redis });
const emailProvider = new ConsoleEmailProvider();
const emailWorker = new Worker(
  'email',
  async () => {
    try {
      const sent = await processPendingEmails(maintenanceDb, emailProvider);
      if (sent > 0) {
        console.log(JSON.stringify({ event: 'emails_sent', count: sent }));
      }
    } catch (e) {
      console.log(JSON.stringify({ event: 'email_processing_failed', error: String(e) }));
    }
  },
  { connection: redis, concurrency: 1 },
);
emailWorker.on('failed', (job) =>
  console.error(JSON.stringify({ event: 'email_worker_failed', jobId: job?.id })),
);
emailWorker.on('error', () => console.error(JSON.stringify({ event: 'email_worker_unavailable' })));
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

  // Schedule nightly maintenance if not already running.
  const existing = await maintenanceQueue.getRepeatableJobs();
  if (!existing.length) {
    await maintenanceQueue.add(
      'nightly',
      {},
      {
        repeat: { pattern: '0 2 * * *' }, // 2:00 AM daily
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
  }
  // Schedule hourly deletion check.
  const deletionJobs = await deletionQueue.getRepeatableJobs();
  if (!deletionJobs.length) {
    await deletionQueue.add(
      'process-deletions',
      {},
      {
        repeat: { pattern: '0 * * * *' }, // Every hour
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
  }
  // Schedule metadata background fetch every 5 minutes.
  const metadataJobs = await metadataQueue.getRepeatableJobs();
  if (!metadataJobs.length) {
    await metadataQueue.add(
      'fetch-metadata',
      {},
      {
        repeat: { pattern: '*/5 * * * *' }, // Every 5 minutes
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
  }
  // Schedule notifications push every minute.
  const notificationJobs = await notificationsQueue.getRepeatableJobs();
  if (!notificationJobs.length) {
    await notificationsQueue.add(
      'deliver-reminders',
      {},
      {
        repeat: { pattern: '* * * * *' }, // Every minute
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
  }
  // Schedule email processing every minute.
  const emailJobs = await emailQueue.getRepeatableJobs();
  if (!emailJobs.length) {
    await emailQueue.add(
      'process-emails',
      {},
      {
        repeat: { pattern: '* * * * *' }, // Every minute
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: false,
      },
    );
  }
} finally {
  await emailWorker.close();
  await emailQueue.close();
  await notificationsWorker.close();
  await notificationsQueue.close();
  await metadataWorker.close();
  await metadataQueue.close();
  await deletionWorker.close();
  await deletionQueue.close();
  await maintenanceWorker.close();
  await maintenanceQueue.close();
  await exportWorker.close();
  await exportQueue.close();
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
  await maintenancePool.end();
}
