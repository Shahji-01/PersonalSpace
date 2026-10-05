import type { SQLiteDatabase } from 'expo-sqlite';
import { z } from 'zod';
import { attachmentLimits } from '@personalspace/validation';

export const downloadedAttachmentSchema = z.object({
  id: z.uuidv7(),
  uri: z.string().startsWith('file:///'),
  mime: z.string().min(1),
  size: z.number().int().positive().max(attachmentLimits.maxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  variant: z.enum(['file', 'thumbnail']).optional(),
});
export type DownloadedAttachment = z.infer<typeof downloadedAttachmentSchema>;
const entrySchema = downloadedAttachmentSchema.extend({
  pinned: z.boolean(),
  accessedAt: z.number().int().nonnegative(),
});
export type AttachmentCacheEntry = z.infer<typeof entrySchema>;
export const cacheLimitsMb = [100, 500, 1000] as const;
export const attachmentCacheTablesSql = `
  CREATE TABLE IF NOT EXISTS attachment_cache (
    user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id)
  );
  CREATE TABLE IF NOT EXISTS attachment_cache_settings (
    user_id TEXT PRIMARY KEY, limit_mb INTEGER NOT NULL
  );`;

export function createAttachmentCacheStore(
  db: SQLiteDatabase,
  userId: string,
  transaction: (work: () => Promise<void>) => Promise<void>,
) {
  return {
    list: async (): Promise<AttachmentCacheEntry[]> =>
      (
        await db.getAllAsync<{ data: string }>(
          'SELECT data FROM attachment_cache WHERE user_id=?',
          userId,
        )
      ).map((row) => entrySchema.parse(JSON.parse(row.data))),
    put: async (raw: AttachmentCacheEntry) => {
      const entry = entrySchema.parse(raw);
      await transaction(async () => {
        await db.runAsync(
          'INSERT OR REPLACE INTO attachment_cache(user_id,id,data) VALUES (?,?,?)',
          userId,
          entry.variant === 'thumbnail' ? `thumbnail:${entry.id}` : entry.id,
          JSON.stringify(entry),
        );
      });
    },
    remove: (id: string, variant?: 'file' | 'thumbnail') =>
      transaction(async () => {
        await db.runAsync(
          'DELETE FROM attachment_cache WHERE user_id=? AND id=?',
          userId,
          variant === 'thumbnail' ? `thumbnail:${id}` : id,
        );
      }),
    limitMb: async () =>
      (
        await db.getFirstAsync<{ limit_mb: number }>(
          'SELECT limit_mb FROM attachment_cache_settings WHERE user_id=?',
          userId,
        )
      )?.limit_mb ?? 500,
    setLimitMb: async (limit: number) => {
      if (!cacheLimitsMb.some((value) => value === limit)) throw new Error('Invalid cache limit');
      await transaction(async () => {
        await db.runAsync(
          'INSERT OR REPLACE INTO attachment_cache_settings(user_id,limit_mb) VALUES (?,?)',
          userId,
          limit,
        );
      });
    },
  };
}
export type AttachmentCacheStore = ReturnType<typeof createAttachmentCacheStore>;
