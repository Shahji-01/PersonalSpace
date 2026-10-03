import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { createAttachmentProcessor, type ProcessingResult } from '@personalspace/domain';
import { attachmentLimits } from '@personalspace/validation';
import type { AttachmentStorage } from '@personalspace/storage';
import type { AttachmentScanner } from './attachment-scanner';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { outboxEvents, type Database } from '@personalspace/db';
import type { Queue } from 'bullmq';

export const processingEventSchema = z.strictObject({ attachmentId: z.uuidv7() });
export async function relayAttachmentProcessing(db: Database, queue: Pick<Queue, 'add'>) {
  const events = await db
    .select()
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.processedAt), eq(outboxEvents.type, 'attachments.process')))
    .orderBy(outboxEvents.createdAt)
    .limit(100);
  for (const event of events) {
    const payload = processingEventSchema.parse(event.payload);
    await queue.add(
      'process',
      { userId: event.userId, payload },
      {
        jobId: event.id,
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

export class RejectedAttachment extends Error {
  constructor(public readonly reason: Extract<ProcessingResult, { status: 'rejected' }>['reason']) {
    super('Attachment rejected');
  }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function prepareAttachment(
  bytes: Buffer,
  declaredMime: string,
  scan: AttachmentScanner,
) {
  if ((await scan(bytes)) !== 'clean') throw new RejectedAttachment('malware');
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch {
    throw new RejectedAttachment('type');
  }
  const textTypes = ['text/plain', 'text/markdown', 'text/csv'];
  if (textTypes.includes(declaredMime)) {
    if (detected) throw new RejectedAttachment('type');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      for (const character of text) {
        const code = character.charCodeAt(0);
        if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
          throw new Error('Binary data');
      }
    } catch {
      throw new RejectedAttachment('type');
    }
    return { bytes, mime: declaredMime, thumbnail: null };
  }
  const detectedMime =
    detected?.mime === 'audio/x-m4a'
      ? 'audio/mp4'
      : detected?.mime === 'audio/ogg; codecs=opus'
        ? 'audio/ogg'
        : detected?.mime === 'image/heif'
          ? 'image/heic'
          : detected?.mime;
  if (!detectedMime || detectedMime !== declaredMime) throw new RejectedAttachment('type');
  if (declaredMime.startsWith('image/')) {
    // Strict decoder + bounded dimensions; animated input is rejected rather than losing frames.
    try {
      const options = { failOn: 'warning' as const, limitInputPixels: 40000000 };
      const metadata = await sharp(bytes, options).metadata();
      if ((metadata.pages ?? 1) > 1) throw new Error('Animated image');
      const output = await sharp(bytes, options)
        .autoOrient()
        .webp({ quality: 90 })
        .timeout({ seconds: 10 })
        .toBuffer();
      const thumbnail = await sharp(output, options)
        .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .timeout({ seconds: 10 })
        .toBuffer();
      if (output.length > attachmentLimits.maxBytes) throw new Error('Oversized output');
      return { bytes: output, mime: 'image/webp', thumbnail };
    } catch {
      throw new RejectedAttachment('invalid_image');
    }
  }
  if (
    !['application/pdf', 'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg'].includes(
      declaredMime,
    )
  )
    throw new RejectedAttachment('type');
  return { bytes, mime: detectedMime, thumbnail: null };
}

export async function processAttachment(
  processor: ReturnType<typeof createAttachmentProcessor>,
  storage: AttachmentStorage,
  scan: AttachmentScanner,
  userId: string,
  id: string,
) {
  const row = await processor.claim(userId, id);
  if (!row) return;
  const token = row.processingToken!;
  try {
    const bytes = await storage.read(row.storageKey, attachmentLimits.maxBytes);
    if (!bytes) throw new RejectedAttachment('missing');
    if (bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256)
      throw new RejectedAttachment('integrity');
    const output = await prepareAttachment(bytes, row.declaredMime, scan);
    await storage.write(row.processedKey!, output.bytes, output.mime);
    if (output.thumbnail) await storage.write(row.thumbnailKey!, output.thumbnail, 'image/webp');
    await processor.finish(userId, id, token, {
      status: 'ready',
      mime: output.mime,
      size: output.bytes.length,
      sha256: hash(output.bytes),
      thumbnailSize: output.thumbnail?.length ?? 0,
    });
  } catch (error) {
    if (error instanceof RejectedAttachment)
      await processor.finish(userId, id, token, { status: 'rejected', reason: error.reason });
    else {
      await processor.release(userId, id, token);
      throw new Error('Attachment processing unavailable');
    }
  }
}
