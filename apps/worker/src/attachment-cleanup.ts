import { z } from 'zod';
import type { AttachmentStorage } from '@personalspace/storage';

export const cleanupEventSchema = z.strictObject({
  key: z.string().max(200),
  uploadId: z.string().min(1).max(2048).nullable(),
  notBefore: z.number().int().nonnegative().safe(),
});
export async function cleanAttachment(
  storage: AttachmentStorage,
  userId: string,
  payload: unknown,
) {
  const data = cleanupEventSchema.parse(payload);
  z.uuid().parse(userId);
  const prefix = `u/${userId}/`;
  if (!data.key.startsWith(prefix)) throw new Error('Invalid cleanup owner');
  z.uuid().parse(data.key.slice(prefix.length));
  if (Date.now() < data.notBefore) throw new Error('Attachment cleanup is not due');
  if (data.uploadId) await storage.abort(data.key, data.uploadId);
  await storage.remove(data.key);
}
