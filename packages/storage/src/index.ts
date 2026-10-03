import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import type { UploadedPart, AttachmentUploadGrant } from '@personalspace/validation';

export interface AttachmentStorage {
  head(key: string): Promise<{ size: number; etag: string } | null>;
  createMultipart(key: string): Promise<string>;
  parts(key: string, uploadId: string): Promise<(UploadedPart & { size: number })[] | null>;
  grant(input: {
    key: string;
    uploadId: string | null;
    number: number;
    size: number;
    sha256: string;
  }): Promise<AttachmentUploadGrant>;
  complete(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const storageConfigSchema = z.object({
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
});
export function readStorageConfig(env: Record<string, string | undefined>) {
  if (!env.S3_BUCKET) {
    if (Object.entries(env).some(([key, value]) => key.startsWith('S3_') && value))
      throw new Error('S3_BUCKET is required when attachment storage is configured.');
    return null;
  }
  const parsed = storageConfigSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid storage configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return parsed.data;
}
export function createS3Storage(config: NonNullable<ReturnType<typeof readStorageConfig>>) {
  const common = {
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
    maxAttempts: 2,
  };
  const client = new S3Client({ ...common, endpoint: config.S3_ENDPOINT });
  const signer = new S3Client({
    ...common,
    endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
  });
  const Bucket = config.S3_BUCKET;
  const send = <T>(run: (signal: AbortSignal) => Promise<T>) => run(AbortSignal.timeout(15000));
  const missing = (error: unknown) =>
    error instanceof Error && ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.name);
  const storage: AttachmentStorage = {
    head: async (Key) => {
      try {
        const object = await send((abortSignal) =>
          client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal }),
        );
        if (object.ContentLength === undefined || !object.ETag)
          throw new Error('Invalid object metadata');
        return { size: object.ContentLength, etag: object.ETag };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    createMultipart: async (Key) => {
      const result = await send((abortSignal) =>
        client.send(
          new CreateMultipartUploadCommand({
            Bucket,
            Key,
            ContentType: 'application/octet-stream',
            Tagging: 'stage=quarantine',
          }),
          { abortSignal },
        ),
      );
      if (!result.UploadId) throw new Error('Missing multipart ID');
      return result.UploadId;
    },
    parts: async (Key, UploadId) => {
      try {
        const result = await send((abortSignal) =>
          client.send(new ListPartsCommand({ Bucket, Key, UploadId, MaxParts: 6 }), {
            abortSignal,
          }),
        );
        if (result.IsTruncated) throw new Error('Unexpected multipart length');
        return (result.Parts ?? []).map((part) => {
          if (!part.PartNumber || !part.ETag || part.Size === undefined)
            throw new Error('Invalid part metadata');
          return { number: part.PartNumber, etag: part.ETag, size: part.Size };
        });
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    grant: async ({
      key: Key,
      uploadId: UploadId,
      number: PartNumber,
      size: ContentLength,
      sha256,
    }) => {
      const headers: Record<string, string> = { 'content-length': String(ContentLength) };
      const command = UploadId
        ? new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength })
        : new PutObjectCommand({
            Bucket,
            Key,
            ContentLength,
            ContentType: 'application/octet-stream',
            ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
            Tagging: 'stage=quarantine',
          });
      if (!UploadId) {
        headers['content-type'] = 'application/octet-stream';
        headers['x-amz-tagging'] = 'stage=quarantine';
        headers['x-amz-checksum-sha256'] = Buffer.from(sha256, 'hex').toString('base64');
      }
      const signing = {
        expiresIn: 300,
        signableHeaders: new Set(['content-length']),
        unhoistableHeaders: new Set(['x-amz-tagging', 'x-amz-checksum-sha256']),
      };
      const url =
        command instanceof UploadPartCommand
          ? await getSignedUrl(signer, command, signing)
          : await getSignedUrl(signer, command, signing);
      return {
        url,
        method: 'PUT',
        headers,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    },
    complete: async (Key, UploadId, parts) => {
      await send((abortSignal) =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId,
            MultipartUpload: {
              Parts: parts.map((part) => ({ PartNumber: part.number, ETag: part.etag })),
            },
          }),
          { abortSignal },
        ),
      );
    },
    abort: async (Key, UploadId) => {
      try {
        await send((abortSignal) =>
          client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }), { abortSignal }),
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    remove: async (Key) => {
      await send((abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal }),
      );
    },
  };
  return {
    ...storage,
    ready: () =>
      send((abortSignal) => client.send(new HeadBucketCommand({ Bucket }), { abortSignal })),
    // Explicit development setup only; startup never changes bucket policies/lifecycle.
    setup: async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch (error) {
        if (!(error instanceof Error) || !['NotFound', 'NoSuchBucket'].includes(error.name))
          throw error;
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'expire-quarantine',
                Status: 'Enabled',
                Filter: { Tag: { Key: 'stage', Value: 'quarantine' } },
                Expiration: { Days: 7 },
              },
            ],
          },
        }),
      );
    },
    close: () => {
      client.destroy();
      signer.destroy();
    },
  };
}
