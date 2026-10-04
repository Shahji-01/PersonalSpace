import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { v7 } from 'uuid';
import { createNativeAttachmentFiles } from './attachment-files';

let directory: string;
const picked = vi.fn(),
  share = vi.fn(),
  fetchMock = vi.fn();
function uri(parts: (string | { uri: string })[]) {
  const [first, ...rest] = parts;
  const base = typeof first === 'string' ? first : first!.uri;
  return pathToFileURL(
    join(
      fileURLToPath(base),
      ...rest.map((part) => (typeof part === 'string' ? part : fileURLToPath(part.uri))),
    ),
  ).href;
}
class NativeFile {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = uri(parts);
  }
  get exists() {
    return existsSync(fileURLToPath(this.uri));
  }
  get size() {
    return statSync(fileURLToPath(this.uri)).size;
  }
  get name() {
    return fileURLToPath(this.uri).split(/[\\/]/).pop()!;
  }
  async bytes() {
    return new Uint8Array(readFileSync(fileURLToPath(this.uri)));
  }
  copy(to: NativeFile) {
    copyFileSync(fileURLToPath(this.uri), fileURLToPath(to.uri));
  }
  delete() {
    unlinkSync(fileURLToPath(this.uri));
  }
  write(bytes: Uint8Array) {
    writeFileSync(fileURLToPath(this.uri), bytes);
  }
  slice(start: number, end: number) {
    return new Blob([new Uint8Array(readFileSync(fileURLToPath(this.uri)).subarray(start, end))]);
  }
}
class NativeDirectory {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = uri(parts);
  }
  create() {
    mkdirSync(fileURLToPath(this.uri), { recursive: true });
  }
  list() {
    return readdirSync(fileURLToPath(this.uri)).map((name) => new NativeFile(this, name));
  }
}
vi.mock('expo-file-system', () => ({
  File: NativeFile,
  Directory: NativeDirectory,
  Paths: {
    get document() {
      return pathToFileURL(join(directory, 'documents')).href;
    },
    get cache() {
      return pathToFileURL(join(directory, 'cache')).href;
    },
  },
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digest: async (_algorithm: string, bytes: Uint8Array) =>
    new Uint8Array(createHash('sha256').update(bytes).digest()).buffer,
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => picked(...args),
}));
vi.mock('expo-network', () => ({
  NetworkStateType: { WIFI: 'WIFI' },
  getNetworkStateAsync: async () => ({ isConnected: true, type: 'WIFI' }),
  addNetworkStateListener: () => ({ remove: () => {} }),
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: (...args: unknown[]) => share(...args),
}));
vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'personalspace-files-'));
  vi.clearAllMocks();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const signal = () => new AbortController().signal;
function select(bytes: Buffer, mime = 'text/plain') {
  const path = join(directory, 'picked.txt');
  writeFileSync(path, bytes);
  picked.mockResolvedValue({
    canceled: false,
    assets: [
      { uri: pathToFileURL(path).href, name: 'नोट.txt', mimeType: mime, size: bytes.length },
    ],
  });
  return path;
}

describe('native attachment adapter with actual filesystem bytes', () => {
  it('makes a durable account copy, fingerprints it and never deletes the picker source', async () => {
    const user = v7(),
      files = await createNativeAttachmentFiles(user, v7),
      bytes = Buffer.from('नमस्ते saved bytes');
    const source = select(bytes),
      job = await files.pick(v7(), signal());
    expect(job!.descriptor.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(job!.localUri).toContain(`/attachments/${user}/`);
    writeFileSync(source, 'source changed');
    expect((await files.inspect(job!.localUri, signal())).sha256).toBe(job!.descriptor.sha256);
    await files.remove(job!.localUri);
    await files.remove(job!.localUri);
    expect(readFileSync(source, 'utf8')).toBe('source changed');
  });
  it('refuses other-account and traversal paths for read, upload and deletion', async () => {
    const a = await createNativeAttachmentFiles(v7(), v7),
      b = await createNativeAttachmentFiles(v7(), v7);
    select(Buffer.from('private'));
    const job = await a.pick(v7(), signal());
    await expect(b.inspect(job!.localUri, signal())).rejects.toMatchObject({ kind: 'local_file' });
    await expect(b.remove(job!.localUri)).rejects.toMatchObject({ kind: 'local_file' });
    await expect(a.remove(`${job!.localUri}/../../outside`)).rejects.toMatchObject({
      kind: 'local_file',
    });
    expect(existsSync(fileURLToPath(job!.localUri))).toBe(true);
  });
  it('uploads only the requested byte range with no ambient credentials', async () => {
    const files = await createNativeAttachmentFiles(v7(), v7);
    select(Buffer.from('0123456789'));
    const job = await files.pick(v7(), signal());
    fetchMock.mockResolvedValue(new Response('', { status: 200, headers: { etag: 'part-etag' } }));
    const grant = {
      url: 'https://storage.example.test/private',
      method: 'PUT' as const,
      headers: { 'content-length': '4' },
      expiresAt: new Date().toISOString(),
    };
    expect(
      await files.put({ localUri: job!.localUri, start: 2, end: 6, grant, signal: signal() }),
    ).toEqual({ status: 200, etag: 'part-etag' });
    const options = fetchMock.mock.calls[0]![1];
    expect(await options.body.text()).toBe('2345');
    expect(options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: grant.headers,
    });
    await expect(
      files.put({ localUri: job!.localUri, start: 2, end: 30, grant, signal: signal() }),
    ).rejects.toMatchObject({ kind: 'local_file' });
  });
  it('verifies downloads before sharing, bounds bytes, and removes cached downloads after deletion', async () => {
    const files = await createNativeAttachmentFiles(v7(), v7),
      bytes = Buffer.from('verified download'),
      id = v7();
    const grant = {
      url: 'https://storage.example.test/file',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: 'text/plain',
    };
    fetchMock.mockImplementation(async () => new Response(bytes));
    await files.share(id, grant, signal(), async () => true);
    const sharedUri = share.mock.calls[0]![0] as string;
    expect(readFileSync(fileURLToPath(sharedUri))).toEqual(bytes);
    await files.pruneDownloads([id]);
    expect(existsSync(fileURLToPath(sharedUri))).toBe(true);
    await files.pruneDownloads([]);
    expect(existsSync(fileURLToPath(sharedUri))).toBe(false);
    await expect(
      files.share(id, { ...grant, sha256: '0'.repeat(64) }, signal(), async () => true),
    ).rejects.toThrow('verification');
    await expect(
      files.share(id, { ...grant, size: 1 }, signal(), async () => true),
    ).rejects.toThrow('expected size');
    await expect(files.share(id, grant, signal(), async () => false)).rejects.toThrow(
      'no longer available',
    );
    expect(share).toHaveBeenCalledTimes(1);
  });
  it('handles cancelled selection and rejects unsupported, empty and oversized files before copying', async () => {
    const files = await createNativeAttachmentFiles(v7(), v7);
    picked.mockResolvedValue({ canceled: true });
    expect(await files.pick(v7(), signal())).toBeNull();
    select(Buffer.from('script'), 'application/javascript');
    await expect(files.pick(v7(), signal())).rejects.toThrow('not supported');
    select(Buffer.alloc(0));
    await expect(files.pick(v7(), signal())).rejects.toThrow('25 MB');
    select(Buffer.alloc(25 * 1024 * 1024 + 1));
    await expect(files.pick(v7(), signal())).rejects.toThrow('25 MB');
  });
});
