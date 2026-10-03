import { z } from 'zod';

export const attachmentLimits = {
  maxBytes: 25 * 1024 * 1024,
  multipartAboveBytes: 5 * 1024 * 1024,
  wifiOnlyAboveBytes: 10 * 1024 * 1024,
} as const;

// These are client declarations. The server must sniff and validate the actual bytes.
export const attachmentMimeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'audio/mp4',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
]);

export const attachmentDescriptorSchema = z.strictObject({
  id: z.uuidv7(),
  parentId: z.uuidv7(),
  filename: z.string().trim().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+$/),
  size: z.number().int().min(1).max(attachmentLimits.maxBytes),
  mime: attachmentMimeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AttachmentDescriptor = z.infer<typeof attachmentDescriptorSchema>;

export const uploadedPartSchema = z.strictObject({
  number: z.number().int().min(1).max(5),
  etag: z.string().min(1).max(1024).regex(/^[^\r\n]+$/),
});
export type UploadedPart = z.infer<typeof uploadedPartSchema>;

export const attachmentUploadSessionSchema = z.strictObject({
  id: z.string().min(1).max(2048),
  partSize: z.number().int().min(attachmentLimits.multipartAboveBytes).max(attachmentLimits.maxBytes),
});

export const attachmentUploadStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('uploading'),
    session: attachmentUploadSessionSchema,
    // Authoritative server list: reconciles a crash after PUT but before local persistence.
    parts: z.array(uploadedPartSchema).max(5),
  }),
  z.strictObject({ status: z.literal('processing') }),
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('rejected') }),
]);
export type AttachmentUploadState = z.infer<typeof attachmentUploadStateSchema>;

export const attachmentTransferSchema = z.strictObject({
  descriptor: attachmentDescriptorSchema,
  // Set only after the picker asset has been copied to account-scoped durable app storage.
  localUri: z.string().min(1).max(4096),
  revision: z.number().int().nonnegative().safe(),
  state: z.enum(['queued', 'uploading', 'processing', 'ready', 'failed', 'auth_required']),
  session: attachmentUploadSessionSchema.nullable(),
  parts: z.array(uploadedPartSchema).max(5),
  failures: z.number().int().nonnegative().max(1000),
  nextAttemptAt: z.number().int().nonnegative().safe(),
  error: z.enum(['retry', 'auth', 'rejected', 'local_file', 'protocol']).nullable(),
  createdAt: z.number().int().nonnegative().safe(),
});
export type AttachmentTransfer = z.infer<typeof attachmentTransferSchema>;
