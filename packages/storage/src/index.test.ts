import { describe, expect, it } from 'vitest';
import { createS3Storage, readStorageConfig } from './index';

const environment = {
  S3_BUCKET: 'private-attachments',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://10.0.2.2:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-only-key',
  S3_SECRET_ACCESS_KEY: 'test-only-secret',
  S3_FORCE_PATH_STYLE: 'true',
};
describe('private object storage configuration and grants', () => {
  it('signs downloads for one minute with encoded filenames and private cache headers', async () => {
    const storage = createS3Storage(readStorageConfig(environment)!);
    try {
      const grant = await storage.download(
        'u/test/processed-key',
        'नोट "quoted".txt',
        'text/plain',
      );
      const url = new URL(grant.url);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
      expect(url.searchParams.get('response-content-type')).toBe('text/plain');
      expect(url.searchParams.get('response-content-disposition')).toContain(
        "filename*=UTF-8''%E0",
      );
      expect(url.searchParams.get('response-content-disposition')).not.toContain('"quoted"');
    } finally {
      storage.close();
    }
  });
  it('keeps storage optional and rejects partial configuration without exposing credentials', () => {
    expect(readStorageConfig({})).toBeNull();
    expect(() => readStorageConfig({ S3_ACCESS_KEY_ID: 'private-value' })).toThrow('S3_BUCKET');
    expect(() => readStorageConfig({ ...environment, S3_SECRET_ACCESS_KEY: 'bad' })).toThrow(
      'S3_SECRET_ACCESS_KEY',
    );
    try {
      readStorageConfig({ ...environment, S3_SECRET_ACCESS_KEY: 'bad' });
    } catch (error) {
      expect(String(error)).not.toContain('bad');
    }
  });
  it('signs exact single-part size/checksum/tag headers for five minutes at the device-visible endpoint', async () => {
    const storage = createS3Storage(readStorageConfig(environment)!);
    try {
      const grant = await storage.grant({
        key: 'u/test/random-key',
        uploadId: null,
        number: 1,
        size: 123,
        sha256: 'a'.repeat(64),
      });
      const url = new URL(grant.url);
      expect(url.host).toBe('10.0.2.2:9000');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.pathname).toBe('/private-attachments/u/test/random-key');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
        expect.arrayContaining(['content-length', 'x-amz-checksum-sha256', 'x-amz-tagging']),
      );
      expect(grant.headers).toMatchObject({
        'content-length': '123',
        'x-amz-tagging': 'stage=quarantine',
        'x-amz-checksum-sha256': Buffer.from('a'.repeat(64), 'hex').toString('base64'),
      });
      expect(grant.headers).not.toHaveProperty('authorization');
    } finally {
      storage.close();
    }
  });
  it('binds multipart grants to their upload ID and part number without leaking a bearer credential', async () => {
    const storage = createS3Storage(readStorageConfig(environment)!);
    try {
      const grant = await storage.grant({
        key: 'u/test/random-key',
        uploadId: 'opaque-session',
        number: 2,
        size: 5 * 1024 * 1024,
        sha256: 'b'.repeat(64),
      });
      const url = new URL(grant.url);
      expect(url.searchParams.get('uploadId')).toBe('opaque-session');
      expect(url.searchParams.get('partNumber')).toBe('2');
      expect(grant.headers).toEqual({ 'content-length': String(5 * 1024 * 1024) });
    } finally {
      storage.close();
    }
  });
});
