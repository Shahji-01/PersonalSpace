import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import {
  attachmentLimits,
  type UploadedPart,
  type AttachmentUploadGrant,
} from '@personalspace/validation';

export interface AttachmentStorage {
  read(key: string, limit: number): Promise<Buffer | null>;
  write(key: string, body: Buffer, mime: string): Promise<void>;
  download(
    key: string,
    filename: string,
    mime: string,
  ): Promise<{ url: string; expiresAt: string }>;
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
    read: async (Key, limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > attachmentLimits.maxBytes)
        throw new Error('Invalid object read limit');
      try {
        return await send(async (abortSignal) => {
          const result = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal });
          const body = result.Body;
          if (!body) throw new Error('Missing object body');
          const abort = () => {
            if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
          };
          abortSignal.addEventListener('abort', abort, { once: true });
          try {
            abortSignal.throwIfAborted();
            if (result.ContentLength === undefined || result.ContentLength > limit)
              throw new Error('Object exceeds read limit');
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const chunk of body as AsyncIterable<Uint8Array>) {
              abortSignal.throwIfAborted();
              length += chunk.length;
              if (length > limit) throw new Error('Object exceeds read limit');
              chunks.push(Buffer.from(chunk));
            }
            abortSignal.throwIfAborted();
            return Buffer.concat(chunks, length);
          } finally {
            abortSignal.removeEventListener('abort', abort);
            if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
          }
        });
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    write: async (Key, Body, ContentType) => {
      if (!Body.length || Body.length > attachmentLimits.maxBytes)
        throw new Error('Invalid output size');
      await send((abortSignal) =>
        client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            ContentLength: Body.length,
            ContentType,
            Tagging: 'stage=stored',
            CacheControl: 'private, no-store',
          }),
          { abortSignal },
        ),
      );
    },
    download: async (Key, filename, mime) => {
      const encoded = encodeURIComponent(filename).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      const url = await getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentType: mime,
          ResponseCacheControl: 'private, no-store',
          ResponseContentDisposition: `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
        }),
        { expiresIn: 60 },
      );
      return { url, expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
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
    // Prefixes are derived only from a validated account ID. Enumerating versions
    // also erases overwritten objects and delete markers in versioned buckets.
    removeAccountObjects: async (userId: string, knownAttachmentKeys: string[] = []) => {
      z.uuid().parse(userId);
      for (const key of knownAttachmentKeys) {
        const prefix = `u/${userId}/`;
        if (!key.startsWith(prefix)) throw new Error('Invalid account storage key');
        z.uuid().parse(key.slice(prefix.length));
      }
      const deadline = Date.now() + 60000;
      const checkTime = () => {
        if (Date.now() >= deadline) throw new Error('Account storage cleanup must continue');
      };
      // MinIO requires the exact object key for multipart listings. Include
      // persisted attachment/cleanup keys as well as the AWS prefix sweep.
      for (const Prefix of new Set([
        ...knownAttachmentKeys,
        `u/${userId}/`,
        `exports/${userId}/`,
      ])) {
        // Always drain the first page: deleting it shifts the next page forward,
        // and a retry after partial failure simply lists the remaining objects.
        for (;;) {
          checkTime();
          const page = await send((abortSignal) =>
            client.send(new ListMultipartUploadsCommand({ Bucket, Prefix, MaxUploads: 100 }), {
              abortSignal,
            }),
          );
          const uploads = page.Uploads ?? [];
          if (!uploads.length) {
            if (page.IsTruncated) throw new Error('Incomplete multipart listing');
            break;
          }
          for (const upload of uploads) {
            checkTime();
            if (
              !upload.Key?.startsWith(Prefix) ||
              !upload.UploadId ||
              (!Prefix.endsWith('/') && upload.Key !== Prefix)
            )
              throw new Error('Invalid account storage listing');
            await storage.abort(upload.Key, upload.UploadId);
          }
        }
        if (!Prefix.endsWith('/')) continue;
        for (;;) {
          checkTime();
          const page = await send((abortSignal) =>
            client.send(new ListObjectVersionsCommand({ Bucket, Prefix, MaxKeys: 1000 }), {
              abortSignal,
            }),
          );
          const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
          if (!versions.length) {
            if (page.IsTruncated) throw new Error('Incomplete object listing');
            break;
          }
          const Objects = versions.map((version) => {
            if (!version.Key?.startsWith(Prefix) || !version.VersionId)
              throw new Error('Invalid account storage listing');
            return { Key: version.Key, VersionId: version.VersionId };
          });
          const result = await send((abortSignal) =>
            client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }), {
              abortSignal,
            }),
          );
          if (result.Errors?.length) throw new Error('Account storage cleanup incomplete');
        }
      }
    },
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
