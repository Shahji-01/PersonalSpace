import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { exportJobs, type Database } from '@personalspace/db';
import { generateExportData } from '@personalspace/domain';
import type { AttachmentStorage } from '@personalspace/storage';
import { buildExportArtifact } from './export-artifact';

export const exportJobSchema = z.object({
  userId: z.uuid(),
  jobId: z.uuid(),
  format: z.enum(['json', 'csv', 'markdown']),
  scope: z.enum(['everything', 'notes', 'tasks', 'learning', 'money']),
});

export async function processExport(db: Database, storage: AttachmentStorage | null, raw: unknown) {
  const input = exportJobSchema.parse(raw);
  const identity = and(
    eq(exportJobs.id, input.jobId),
    eq(exportJobs.userId, input.userId),
    eq(exportJobs.format, input.format),
    eq(exportJobs.scope, input.scope),
  );
  const extension = input.format === 'json' ? 'json' : 'zip';
  // Separate attempt keys prevent a late worker from overwriting a newer artifact.
  const key = `exports/${input.userId}/${input.jobId}/${randomUUID()}.${extension}`;
  const [claimed] = await db
    .update(exportJobs)
    .set({
      status: 'processing',
      startedAt: new Date(),
      completedAt: null,
      error: null,
      storageKey: key,
      sizeBytes: null,
      downloadUrlExpiresAt: null,
    })
    .where(and(identity, inArray(exportJobs.status, ['queued', 'processing', 'failed'])))
    .returning({ id: exportJobs.id });
  if (!claimed) return; // Ready, expired, deleted or mismatched jobs cannot be republished.
  const ownsAttempt = and(
    identity,
    eq(exportJobs.status, 'processing'),
    eq(exportJobs.storageKey, key),
  );
  let wrote = false;
  try {
    if (!storage) throw new Error('Export storage unavailable');
    const data = await generateExportData(db, input.userId, input.scope);
    const artifact = await buildExportArtifact(data, input.format);
    wrote = true; // A failed PUT may still have committed remotely.
    await storage.write(key, artifact.body, artifact.mime);
    const stored = await storage.head(key);
    if (!stored || stored.size !== artifact.body.length)
      throw new Error('Export storage verification failed');
    const ready = await db
      .update(exportJobs)
      .set({
        status: 'ready',
        sizeBytes: artifact.body.length,
        completedAt: new Date(),
        downloadUrlExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      })
      .where(ownsAttempt)
      .returning({ id: exportJobs.id });
    if (!ready.length) await storage.remove(key);
  } catch {
    let retainedKey: string | null = null;
    if (wrote && storage) {
      try {
        await storage.remove(key);
      } catch {
        retainedKey = key;
      }
    }
    await db
      .update(exportJobs)
      .set({
        status: 'failed',
        storageKey: retainedKey,
        sizeBytes: null,
        error: 'Export generation failed. Please retry.',
        completedAt: new Date(),
        downloadUrlExpiresAt: null,
      })
      .where(ownsAttempt);
    // Storage/provider errors can contain private keys or response bodies.
    throw new Error('Export generation failed');
  }
}
