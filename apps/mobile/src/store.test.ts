import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { plainTextDocument } from '@personalspace/editor-schema';
import { newAttachmentTransfer } from '@personalspace/sync';
import {
  recordSchema,
  searchQuerySchema,
  type Mutation,
  type RecordItem,
} from '@personalspace/validation';
import { openStore, CACHE_MIGRATIONS } from './store';
import { ApiError, createClient } from '@personalspace/api-client';
import { createAttachmentRuntime } from './attachment-runtime';
import type { AttachmentFiles } from './attachment-files';
import { createAttachmentCache } from './attachment-cache';
import type { AttachmentCacheEntry } from './attachment-cache-store';

let database: DatabaseSync;
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => randomBytes(count) }));
// Exercise the actual store queries/transactions against SQLite; only the native binding differs.
vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => database.exec(sql),
    runAsync: async (sql: string, ...args: SQLInputValue[]) => database.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: SQLInputValue[]) =>
      database.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: SQLInputValue[]) =>
      database.prepare(sql).get(...args) ?? null,
    withTransactionAsync: async (work: () => Promise<void>) => {
      database.exec('BEGIN');
      try {
        await work();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    closeAsync: async () => {},
  }),
}));

beforeEach(() => {
  database = new DatabaseSync(':memory:');
});
afterEach(() => database.close());

const userVersion = () =>
  (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

describe('cache migrations', () => {
  it('stamps the schema version and re-opening is a no-op', async () => {
    const userId = v7();
    await openStore(userId);
    expect(userVersion()).toBe(CACHE_MIGRATIONS.length);
    await openStore(userId);
    expect(userVersion()).toBe(CACHE_MIGRATIONS.length);
  });

  it('adopts a pre-versioning database whose tables already exist at user_version 0', async () => {
    database.exec(CACHE_MIGRATIONS[0]!);
    expect(userVersion()).toBe(0);
    await openStore(v7());
    expect(userVersion()).toBe(CACHE_MIGRATIONS.length);
  });
});

function note(version = 3): RecordItem {
  const now = new Date().toISOString();
  return recordSchema.parse({
    id: v7(),
    type: 'note',
    text: 'Original',
    status: 'active',
    plannedDate: null,
    version,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

function attachment(parentId = v7()) {
  return newAttachmentTransfer(
    {
      id: v7(),
      parentId,
      filename: 'private receipt.jpg',
      mime: 'image/jpeg',
      size: 12 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    },
    `file:///documents/account/${v7()}`,
  );
}

function readyAttachment(parent: RecordItem, job: ReturnType<typeof attachment>) {
  return recordSchema.parse({
    ...parent,
    id: job.descriptor.id,
    type: 'attachment',
    parentId: parent.id,
    version: parent.version + 1,
    attachment: {
      ...job.descriptor,
      status: 'ready',
      processedMime: 'image/webp',
      processedSize: 100,
      processedSha256: 'b'.repeat(64),
    },
  });
}

async function runtimeFixture() {
  const store = await openStore('a'),
    parent = note(),
    job = attachment(parent.id);
  await store.merge([parent], parent.version);
  let network: (value: { connected: boolean; wifi: boolean }) => void = () => {};
  const files: AttachmentFiles = {
    pick: vi.fn(async () => job),
    inspect: vi.fn(async () => ({ size: job.descriptor.size, sha256: job.descriptor.sha256 })),
    put: vi.fn(async () => ({ status: 200, etag: 'etag' })),
    remove: vi.fn(async () => {}),
    download: vi.fn(async (id, grant, _signal, _permitted, variant) => ({
      id,
      uri: `file:///downloads/${id}${variant === 'thumbnail' ? '.thumbnail' : ''}.txt`,
      size: grant.size,
      mime: grant.mime,
      sha256: grant.sha256!,
      ...(variant === 'thumbnail' ? { variant } : {}),
    })),
    shareDownloaded: vi.fn(async () => {}),
    verifyDownload: vi.fn(async () => true),
    previewData: vi.fn(async () => 'data:image/webp;base64,UklGRfixture'),
    hasDownload: vi.fn(async () => true),
    removeDownload: vi.fn(async () => {}),
    reconcileDownloads: vi.fn(async () => {}),
    reclaimOriginals: vi.fn(async () => {}),
    originalBytes: vi.fn(async () => job.descriptor.size),
    watchNetwork: (listener) => {
      network = listener;
      return () => {};
    },
  };
  const client = {
    ...createClient('https://api.example.test', () => 'token'),
    openAttachment: vi.fn(async () => ({
      status: 'uploading' as const,
      session: { id: 'session', partSize: 5 * 1024 * 1024 },
      parts: [],
    })),
    attachmentPart: vi.fn(async () => ({
      url: 'https://storage.example.test',
      method: 'PUT' as const,
      headers: { 'content-length': '1' },
      expiresAt: new Date().toISOString(),
    })),
    completeAttachment: vi.fn(async () => ({ status: 'ready' as const })),
    removeAttachment: vi.fn(async () => ({ cancelled: true as const })),
    downloadAttachment: vi.fn(async () => ({
      url: 'https://storage.example.test/file',
      expiresAt: new Date().toISOString(),
      mime: 'text/plain',
      size: 10,
      sha256: 'a'.repeat(64),
    })),
  };
  const onRemoteChange = vi.fn();
  const runtime = createAttachmentRuntime({ store, client, files, onRemoteChange });
  return {
    store,
    parent,
    job,
    files,
    client,
    runtime,
    onRemoteChange,
    network: (connected: boolean, wifi = false) => network({ connected, wifi }),
  };
}

describe('foreground attachment runtime', () => {
  it('reclaims completed originals only after matching ready metadata syncs, retrying disk failures', async () => {
    const f = await runtimeFixture(),
      id = f.job.descriptor.id;
    try {
      await f.runtime.pick(f.parent.id);
      f.network(true, true);
      f.runtime.setActive(true);
      await f.runtime.request();
      expect((await f.store.attachmentTransfers.get(id))!.state).toBe('ready');
      expect(f.files.remove).not.toHaveBeenCalled();
      await f.runtime.keepOffline(id);
      const pins = await f.store.attachmentCache.list();
      await f.store.merge([readyAttachment(f.parent, f.job)], 4);
      vi.mocked(f.files.remove).mockRejectedValueOnce(new Error('disk locked'));
      await f.runtime.request();
      expect(await f.store.attachmentTransfers.pendingFileRemovals()).toEqual([
        { id, localUri: f.job.localUri },
      ]);
      expect((await f.store.attachmentTransfers.get(id))!.originalCleanupScheduled).toBe(true);
      await f.runtime.request();
      expect(await f.store.attachmentTransfers.pendingFileRemovals()).toEqual([]);
      expect(await f.store.attachmentCache.list()).toEqual(pins);
      const removals = vi.mocked(f.files.remove).mock.calls.length;
      await f.runtime.retry(id);
      await f.runtime.request();
      expect(f.files.remove).toHaveBeenCalledTimes(removals);
      expect(f.client.removeAttachment).not.toHaveBeenCalled();
      f.network(false);
      await f.runtime.share(id);
      expect(f.files.shareDownloaded).toHaveBeenCalled();
    } finally {
      f.runtime.dispose();
    }
  });
  it('does not block uploads or runtime requests behind automatic preview I/O', async () => {
    const f = await runtimeFixture(),
      id = v7();
    await f.store.merge(
      [
        recordSchema.parse({
          ...f.parent,
          id,
          type: 'attachment',
          parentId: f.parent.id,
          version: 4,
          attachment: {
            ...f.job.descriptor,
            id,
            status: 'ready',
            hasThumbnail: true,
            processedMime: 'image/webp',
          },
        }),
      ],
      4,
    );
    let finish: () => void = () => {};
    let downloadSignal: AbortSignal | undefined;
    vi.mocked(f.files.download).mockImplementationOnce(async (_id, _grant, signal) => {
      downloadSignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      signal.throwIfAborted();
      return { ...cachedFile(1), id, variant: 'thumbnail' };
    });
    try {
      f.network(true, true);
      f.runtime.setActive(true);
      await vi.waitFor(() => expect(f.files.download).toHaveBeenCalledTimes(1));
      await f.runtime.pick(f.parent.id);
      await f.runtime.request();
      expect((await f.store.attachmentTransfers.get(f.job.descriptor.id))!.state).toBe('ready');
      f.runtime.setActive(false);
      expect(downloadSignal!.aborted).toBe(true);
    } finally {
      finish();
      f.runtime.dispose();
    }
  });
  it('prefetches recent synced thumbnails independently and pauses refill after clearing cache', async () => {
    const f = await runtimeFixture();
    const id = f.job.descriptor.id;
    await f.store.merge(
      [
        recordSchema.parse({
          ...f.parent,
          id,
          type: 'attachment',
          parentId: f.parent.id,
          version: 4,
          attachment: {
            ...f.job.descriptor,
            status: 'ready',
            hasThumbnail: true,
            processedMime: 'image/webp',
          },
        }),
      ],
      4,
    );
    try {
      f.network(true, true);
      await f.runtime.request();
      expect(f.files.download).not.toHaveBeenCalled();
      f.runtime.setActive(true);
      await vi.waitFor(async () =>
        expect(await f.store.attachmentCache.list()).toMatchObject([
          { id, variant: 'thumbnail', pinned: false },
        ]),
      );
      expect(f.client.downloadAttachment).toHaveBeenCalledWith(id, 'thumbnail');
      expect(f.files.shareDownloaded).not.toHaveBeenCalled();
      await f.runtime.clearCache();
      await f.runtime.request();
      expect(await f.store.attachmentCache.list()).toEqual([]);
      f.runtime.setActive(false);
      f.runtime.setActive(true);
      await vi.waitFor(async () => expect(await f.store.attachmentCache.list()).toHaveLength(1));
    } finally {
      f.runtime.dispose();
    }
  });
  it('finishes startup orphan cleanup before a picker can create a new durable copy', async () => {
    const f = await runtimeFixture();
    await f.store.attachmentTransfers.enqueue(f.job);
    let finish: () => void = () => {};
    vi.mocked(f.files.reclaimOriginals).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const request = f.runtime.request(),
      pick = f.runtime.pick(f.parent.id);
    try {
      await vi.waitFor(() =>
        expect(f.files.reclaimOriginals).toHaveBeenCalledWith([f.job.localUri]),
      );
      expect(f.files.pick).not.toHaveBeenCalled();
      finish();
      await pick;
      await request;
      expect(f.files.pick).toHaveBeenCalledTimes(1);
      expect(f.files.reclaimOriginals).toHaveBeenCalledTimes(1);
    } finally {
      f.runtime.dispose();
    }
  });
  it('keeps a large picked file offline until Wi-Fi or a session override, independently of row sync', async () => {
    const f = await runtimeFixture();
    try {
      f.runtime.setActive(true);
      f.network(true, false);
      await f.runtime.pick(f.parent.id);
      await f.runtime.request();
      expect(f.client.openAttachment).not.toHaveBeenCalled();
      expect((await f.store.attachmentTransfers.list())[0]!.state).toBe('queued');
      f.runtime.setCellular(true);
      await f.runtime.request();
      expect(f.files.put).toHaveBeenCalledTimes(3);
      expect((await f.store.attachmentTransfers.get(f.job.descriptor.id))!.state).toBe('ready');
      expect(f.onRemoteChange).toHaveBeenCalled();
      expect((await f.store.list()).find((item) => item.id === f.parent.id)!.version).toBe(
        f.parent.version,
      );
      // A completed download remains usable while metadata row sync catches up.
      await f.store.merge(
        [
          recordSchema.parse({
            ...f.parent,
            id: f.job.descriptor.id,
            type: 'attachment',
            parentId: f.parent.id,
            version: f.parent.version + 1,
            attachment: { ...f.job.descriptor, status: 'processing' },
          }),
        ],
        f.parent.version + 1,
      );
      await f.runtime.keepOffline(f.job.descriptor.id);
      await f.runtime.request();
      expect(await f.store.attachmentCache.list()).toHaveLength(1);
      await f.runtime.remove(f.job.descriptor.id);
      await f.runtime.request();
      await vi.waitFor(async () => expect(await f.store.attachmentCache.list()).toEqual([]));
    } finally {
      f.runtime.dispose();
    }
  });
  it('aborts a foreground PUT on backgrounding and ignores its late response', async () => {
    const f = await runtimeFixture();
    let finish: (result: { status: number; etag: string }) => void = () => {};
    let uploadSignal: AbortSignal | undefined;
    vi.mocked(f.files.put).mockImplementationOnce((input) => {
      uploadSignal = input.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    try {
      f.network(true, true);
      f.runtime.setActive(true);
      await f.runtime.pick(f.parent.id);
      await vi.waitFor(() => expect(f.files.put).toHaveBeenCalledTimes(1));
      f.runtime.setActive(false);
      expect(uploadSignal!.aborted).toBe(true);
      finish({ status: 200, etag: 'late' });
      await f.runtime.request();
      expect((await f.store.attachmentTransfers.get(f.job.descriptor.id))!.parts).toEqual([]);
      f.runtime.setActive(true);
      await f.runtime.request();
      expect((await f.store.attachmentTransfers.get(f.job.descriptor.id))!.state).toBe('ready');
    } finally {
      f.runtime.dispose();
    }
  });
  it('keeps server removals on failure and acknowledges local cleanup only after deletion succeeds', async () => {
    const f = await runtimeFixture();
    try {
      f.runtime.setActive(true);
      await f.runtime.pick(f.parent.id);
      await f.runtime.request();
      vi.mocked(f.files.remove).mockRejectedValueOnce(new Error('file locked'));
      await f.runtime.remove(f.job.descriptor.id);
      await f.runtime.request();
      expect(await f.store.attachmentTransfers.pendingRemoteRemovals()).toHaveLength(1);
      expect(f.client.openAttachment).not.toHaveBeenCalled();
      f.client.removeAttachment.mockRejectedValueOnce(
        new ApiError(503, 'UNAVAILABLE', 'unavailable'),
      );
      f.network(true, true);
      await f.runtime.request();
      // A repeat request may already have retried the transient failure; force one
      // more drain and verify only successful acknowledgements retire the request.
      await f.runtime.request();
      expect(f.client.removeAttachment).toHaveBeenCalledWith(f.job.descriptor.id);
      expect(await f.store.attachmentTransfers.pendingRemoteRemovals()).toEqual([]);
      expect(await f.store.attachmentTransfers.pendingFileRemovals()).toEqual([]);
      expect(f.client.openAttachment).not.toHaveBeenCalled();
    } finally {
      f.runtime.dispose();
    }
  });
  it('does not enqueue a picker result returned after sign-out', async () => {
    const f = await runtimeFixture();
    let finish: (job: typeof f.job) => void = () => {};
    vi.mocked(f.files.pick).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pick = f.runtime.pick(f.parent.id);
    await vi.waitFor(() => expect(f.files.pick).toHaveBeenCalled());
    f.runtime.dispose();
    finish(f.job);
    await expect(pick).rejects.toThrow();
    expect(await f.store.attachmentTransfers.list()).toEqual([]);
    expect(f.files.remove).toHaveBeenCalledWith(f.job.localUri);
  });
});

async function cacheFixture() {
  const f = await runtimeFixture();
  f.runtime.dispose();
  const controller = new AbortController();
  let connected = true,
    permitted = true;
  const cache = createAttachmentCache({
    store: f.store.attachmentCache,
    files: f.files,
    signal: controller.signal,
    connected: () => connected,
    permitted: async () => permitted,
    grant: f.client.downloadAttachment,
    onChange: () => {},
  });
  return {
    ...f,
    cache,
    controller,
    offline: () => {
      connected = false;
    },
    revoke: () => {
      permitted = false;
    },
  };
}
function cachedFile(accessedAt: number, pinned = false): AttachmentCacheEntry {
  const id = v7();
  return {
    id,
    uri: `file:///downloads/${id}.txt`,
    mime: 'text/plain',
    size: 25 * 1024 * 1024,
    sha256: 'a'.repeat(64),
    accessedAt,
    pinned,
  };
}
describe('durable offline download cache', () => {
  it('prefetches only thumbnails without evicting cached files or touching recency on a repeat', async () => {
    const f = await cacheFixture(),
      id = v7(),
      signal = new AbortController().signal;
    await f.cache.prefetchThumbnail(id, signal);
    const entry = (await f.store.attachmentCache.list())[0]!;
    await f.cache.prefetchThumbnail(id, signal);
    expect((await f.store.attachmentCache.list())[0]!.accessedAt).toBe(entry.accessedAt);
    expect(f.files.download).toHaveBeenCalledTimes(1);
    expect(f.files.previewData).not.toHaveBeenCalled();
    await f.cache.setLimitMb(100);
    for (let i = 0; i < 4; i++) await f.store.attachmentCache.put(cachedFile(i, i === 0));
    expect(await f.cache.prefetchThumbnail(v7(), signal)).toBe('full');
    expect(f.files.download).toHaveBeenCalledTimes(1);
    expect(f.files.removeDownload).not.toHaveBeenCalled();
    // A grant larger than remaining room also leaves existing downloads intact.
    await f.store.attachmentCache.remove(entry.id, 'thumbnail');
    const files = await f.store.attachmentCache.list();
    await f.store.attachmentCache.remove(files[0]!.id);
    f.client.downloadAttachment.mockResolvedValueOnce({
      url: 'https://storage.example.test/file',
      expiresAt: '',
      mime: 'image/webp',
      size: 26 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    });
    expect(await f.cache.prefetchThumbnail(v7(), signal)).toBe('full');
    expect(f.files.removeDownload).not.toHaveBeenCalled();
  });
  it('discards thumbnail downloads cancelled during I/O and never publishes revoked data', async () => {
    const f = await cacheFixture(),
      controller = new AbortController();
    vi.mocked(f.files.download).mockImplementationOnce(async (id) => {
      controller.abort();
      return { ...cachedFile(1), id, variant: 'thumbnail' };
    });
    await expect(f.cache.prefetchThumbnail(v7(), controller.signal)).rejects.toThrow();
    expect(await f.store.attachmentCache.list()).toEqual([]);
    expect(f.files.removeDownload).toHaveBeenCalledTimes(1);
    await expect(f.cache.prefetchThumbnail(v7(), controller.signal)).rejects.toThrow();
    expect(f.files.download).toHaveBeenCalledTimes(1);
  });
  it('stores thumbnails separately, reuses them offline, and unpins both variants', async () => {
    const f = await cacheFixture(),
      id = v7();
    await f.cache.pin(id);
    await f.cache.pinPreview(id);
    expect(await (await openStore('a')).attachmentCache.list()).toHaveLength(2);
    expect(await (await openStore('b')).attachmentCache.list()).toEqual([]);
    expect(f.client.downloadAttachment).toHaveBeenNthCalledWith(1, id, 'file');
    expect(f.client.downloadAttachment).toHaveBeenNthCalledWith(2, id, 'thumbnail');
    f.offline();
    await f.cache.preview(id);
    await f.cache.share(id);
    expect(f.client.downloadAttachment).toHaveBeenCalledTimes(2);
    expect(f.files.previewData).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'thumbnail' }),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(f.files.shareDownloaded).mock.calls[0]![0].variant).toBeUndefined();
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toHaveLength(2);
    await f.cache.unpin(id);
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toEqual([]);
  });
  it('does not return preview bytes after access is revoked during a disk read', async () => {
    const f = await cacheFixture();
    vi.mocked(f.files.previewData).mockImplementationOnce(async () => {
      f.revoke();
      return 'private bytes';
    });
    await expect(f.cache.preview(v7())).rejects.toThrow('no longer available');
    await f.cache.maintain();
    expect(await f.store.attachmentCache.list()).toEqual([]);
  });
  it('persists pins and per-account settings across reopening and shares verified files offline', async () => {
    const f = await cacheFixture(),
      id = v7();
    await f.cache.pin(id);
    await f.cache.setLimitMb(100);
    const reopened = (await openStore('a')).attachmentCache;
    expect(await reopened.limitMb()).toBe(100);
    expect(await reopened.list()).toMatchObject([{ id, pinned: true }]);
    const other = (await openStore('b')).attachmentCache;
    expect(await other.list()).toEqual([]);
    expect(await other.limitMb()).toBe(500);
    await other.remove(id);
    f.offline();
    await f.cache.share(id);
    expect(f.files.verifyDownload).toHaveBeenCalledTimes(1);
    expect(f.files.shareDownloaded).toHaveBeenCalledTimes(1);
    expect(f.client.downloadAttachment).toHaveBeenCalledTimes(1);
    await expect(f.cache.pin(v7())).rejects.toThrow('Available when online');
    await expect(f.cache.setLimitMb(1)).rejects.toThrow('Invalid cache limit');
    expect(await reopened.limitMb()).toBe(100);
  });
  it('evicts least-recently-used unpinned downloads and clear-cache preserves pins and upload originals', async () => {
    const f = await cacheFixture();
    const entries = Array.from({ length: 6 }, (_, i) => cachedFile(i, i === 0));
    for (const entry of entries) await f.store.attachmentCache.put(entry);
    await f.cache.share(entries[1]!.id); // Refresh an otherwise old entry.
    await f.cache.setLimitMb(100);
    expect((await f.store.attachmentCache.list()).map((item) => item.id).sort()).toEqual(
      [entries[0]!, entries[1]!, entries[4]!, entries[5]!].map((item) => item.id).sort(),
    );
    expect((await f.cache.usage()).downloadedBytes).toBe(100 * 1024 * 1024);
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toEqual([entries[0]]);
    expect(f.files.remove).not.toHaveBeenCalled();
    expect((await f.cache.usage()).originalBytes).toBe(f.job.descriptor.size);
    await f.cache.unpin(entries[0]!.id);
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toEqual([]);
  });
  it('retains pins above the cache limit but removes them when their attachment is revoked', async () => {
    const f = await cacheFixture();
    for (let i = 0; i < 5; i++) await f.store.attachmentCache.put(cachedFile(i, true));
    await f.cache.setLimitMb(100);
    expect((await f.cache.usage()).pinnedBytes).toBe(125 * 1024 * 1024);
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toHaveLength(5);
    f.revoke();
    await f.cache.maintain();
    expect(await f.store.attachmentCache.list()).toEqual([]);
    expect(f.files.reconcileDownloads).toHaveBeenLastCalledWith([]);
  });
  it('retains deletion metadata on disk failure and retries; invalid offline bytes are never shared', async () => {
    const f = await cacheFixture(),
      entry = cachedFile(1);
    await f.store.attachmentCache.put(entry);
    vi.mocked(f.files.removeDownload).mockRejectedValueOnce(new Error('file locked'));
    await expect(f.cache.clear()).rejects.toThrow('file locked');
    expect(await f.store.attachmentCache.list()).toEqual([entry]);
    await f.cache.clear();
    expect(await f.store.attachmentCache.list()).toEqual([]);
    await f.store.attachmentCache.put({ ...entry, pinned: true });
    vi.mocked(f.files.verifyDownload).mockResolvedValue(false);
    f.offline();
    await expect(f.cache.share(entry.id)).rejects.toThrow('Available when online');
    expect(f.files.shareDownloaded).not.toHaveBeenCalled();
    expect(await f.store.attachmentCache.list()).toEqual([]);
  });
  it('orders cache clearing after an active share sheet and does not publish a download revoked in flight', async () => {
    const f = await cacheFixture(),
      id = v7();
    let finish: () => void = () => {};
    vi.mocked(f.files.shareDownloaded).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const sharing = f.cache.share(id);
    await vi.waitFor(() => expect(f.files.shareDownloaded).toHaveBeenCalledTimes(1));
    const clearing = f.cache.clear();
    expect(f.files.removeDownload).not.toHaveBeenCalled();
    finish();
    await sharing;
    await clearing;
    expect(await f.store.attachmentCache.list()).toEqual([]);
    vi.mocked(f.files.download).mockImplementationOnce(async (id, grant) => {
      f.revoke();
      return {
        id,
        uri: `file:///downloads/${id}.txt`,
        mime: grant.mime,
        size: grant.size,
        sha256: grant.sha256!,
      };
    });
    await expect(f.cache.pin(v7())).rejects.toThrow('no longer available');
    expect(await f.store.attachmentCache.list()).toEqual([]);
  });
  it('aborts downloads at sign-out and refuses later operations', async () => {
    const f = await cacheFixture();
    vi.mocked(f.files.download).mockImplementationOnce(async () => {
      f.controller.abort();
      return cachedFile(1);
    });
    await expect(f.cache.pin(v7())).rejects.toThrow();
    expect(await f.store.attachmentCache.list()).toEqual([]);
    await expect(f.cache.clear()).rejects.toThrow();
  });
  it('repairs a manifest left behind by interrupted file deletion before reporting it as cached', async () => {
    const f = await cacheFixture(),
      entry = cachedFile(1, true);
    await f.store.attachmentCache.put(entry);
    vi.mocked(f.files.hasDownload).mockResolvedValue(false);
    await f.cache.maintain();
    expect(await f.store.attachmentCache.list()).toEqual([]);
    expect(f.files.reconcileDownloads).toHaveBeenLastCalledWith([]);
  });
});

describe('account-scoped attachment persistence', () => {
  it('reserves completed-original cleanup atomically and preserves the ready attachment across reopening', async () => {
    const store = await openStore('a'),
      parent = note(),
      original = attachment(parent.id);
    await store.merge([parent, readyAttachment(parent, original)], 4);
    await store.attachmentTransfers.enqueue(original);
    expect(
      await store.attachmentTransfers.queueCompletedOriginalCleanup(original.descriptor.id, 0),
    ).toBe(false);
    await store.attachmentTransfers.replace(0, { ...original, revision: 1, state: 'ready' });
    expect(
      await (
        await openStore('b')
      ).attachmentTransfers.queueCompletedOriginalCleanup(original.descriptor.id, 1),
    ).toBe(false);
    expect(
      await store.attachmentTransfers.queueCompletedOriginalCleanup(original.descriptor.id, 0),
    ).toBe(false);
    expect(
      await store.attachmentTransfers.queueCompletedOriginalCleanup(original.descriptor.id, 1),
    ).toBe(true);
    const reopened = (await openStore('a')).attachmentTransfers;
    expect(await reopened.pendingFileRemovals()).toEqual([
      { id: original.descriptor.id, localUri: original.localUri },
    ]);
    expect(await reopened.get(original.descriptor.id)).toMatchObject({
      revision: 2,
      state: 'ready',
      originalCleanupScheduled: true,
    });
    expect(await reopened.removedIds()).toEqual([]);
    expect(await reopened.pendingRemoteRemovals()).toEqual([]);
    expect(await reopened.queueCompletedOriginalCleanup(original.descriptor.id, 2)).toBe(false);
    await reopened.acknowledgeFileRemoval(original.descriptor.id);
    expect(await reopened.queueCompletedOriginalCleanup(original.descriptor.id, 2)).toBe(false);
    expect(await reopened.replace(2, { ...original, revision: 3, state: 'queued' })).toBe(false);
    await reopened.enqueue(original); // Retrying the original enqueue never resets a retired upload.
    expect((await reopened.get(original.descriptor.id))!.state).toBe('ready');
    expect(await reopened.pendingFileRemovals()).toEqual([]);
    await reopened.requestRemoval(original.descriptor.id);
    expect(await reopened.get(original.descriptor.id)).toBeNull();
    expect(await reopened.pendingRemoteRemovals()).toEqual([{ id: original.descriptor.id }]);
  });
  it('protects originals until synced metadata is ready, live and matches their identity', async () => {
    const store = await openStore('a'),
      parent = note(),
      original = attachment(parent.id),
      id = original.descriptor.id;
    await store.merge([parent], 3);
    await store.attachmentTransfers.enqueue(original);
    await store.attachmentTransfers.replace(0, { ...original, revision: 1, state: 'ready' });
    expect(await store.attachmentTransfers.queueCompletedOriginalCleanup(id, 1)).toBe(false);
    const valid = readyAttachment(parent, original);
    const variants = [
      { ...valid, attachment: { ...valid.attachment!, status: 'processing' as const } },
      { ...valid, attachment: { ...valid.attachment!, sha256: 'c'.repeat(64) } },
      { ...valid, attachment: { ...valid.attachment!, processedSha256: null } },
      { ...valid, attachment: { ...valid.attachment!, size: 20 } },
      { ...valid, deletedAt: new Date().toISOString() },
    ];
    let version = 4;
    for (const remote of variants) {
      await store.merge([{ ...remote, version: ++version }], version);
      expect(await store.attachmentTransfers.queueCompletedOriginalCleanup(id, 1)).toBe(false);
    }
    await store.merge(
      [
        { ...valid, version: ++version },
        { ...parent, version, deletedAt: new Date().toISOString() },
      ],
      version,
    );
    expect(await store.attachmentTransfers.queueCompletedOriginalCleanup(id, 1)).toBe(false);
    expect(await store.attachmentTransfers.pendingFileRemovals()).toEqual([]);
    expect((await store.attachmentTransfers.get(id))!.originalCleanupScheduled).toBeUndefined();
    await expect(
      store.attachmentTransfers.replace(1, {
        ...original,
        revision: 2,
        state: 'ready',
        originalCleanupScheduled: true,
      }),
    ).rejects.toThrow('synced confirmation');
  });
  it('rolls back cleanup reservation if its transfer marker cannot be saved', async () => {
    const store = await openStore('a'),
      parent = note(),
      original = attachment(parent.id);
    await store.merge([parent, readyAttachment(parent, original)], 4);
    await store.attachmentTransfers.enqueue(original);
    await store.attachmentTransfers.replace(0, { ...original, revision: 1, state: 'ready' });
    database.exec(
      "CREATE TRIGGER fail_cleanup BEFORE UPDATE ON attachment_transfers BEGIN SELECT RAISE(ABORT,'disk full'); END;",
    );
    await expect(
      store.attachmentTransfers.queueCompletedOriginalCleanup(original.descriptor.id, 1),
    ).rejects.toThrow('disk full');
    expect(await store.attachmentTransfers.pendingFileRemovals()).toEqual([]);
    expect(await store.attachmentTransfers.get(original.descriptor.id)).toMatchObject({
      revision: 1,
      state: 'ready',
    });
    expect(
      (await store.attachmentTransfers.get(original.descriptor.id))!.originalCleanupScheduled,
    ).toBeUndefined();
  });
  it('persists offline removals across reopening without leaking between accounts', async () => {
    const store = await openStore('a'),
      original = attachment();
    await store.attachmentTransfers.enqueue(original);
    await store.attachmentTransfers.requestRemoval(original.descriptor.id);
    const reopened = (await openStore('a')).attachmentTransfers;
    expect(await reopened.pendingRemoteRemovals()).toEqual([{ id: original.descriptor.id }]);
    expect(await reopened.removedIds()).toContain(original.descriptor.id);
    expect(await reopened.get(original.descriptor.id)).toBeNull();
    expect(await (await openStore('b')).attachmentTransfers.pendingRemoteRemovals()).toEqual([]);
    await reopened.acknowledgeRemoteRemoval(original.descriptor.id);
    expect(await reopened.pendingRemoteRemovals()).toEqual([]);
    await expect(reopened.enqueue(original)).rejects.toThrow('permanently deleted');
  });
  it('retains multipart progress and retry deadlines across reopening and duplicate enqueue', async () => {
    const store = await openStore('a');
    const original = attachment();
    await store.attachmentTransfers.enqueue(original);
    const progressed = {
      ...original,
      revision: 1,
      state: 'uploading' as const,
      session: { id: 'private-session', partSize: 5 * 1024 * 1024 },
      parts: [{ number: 1, etag: 'first-part' }],
      failures: 3,
      nextAttemptAt: 1234567,
      error: 'retry' as const,
    };
    expect(await store.attachmentTransfers.replace(0, progressed)).toBe(true);
    await store.attachmentTransfers.enqueue(original);
    const reopened = await openStore('a');
    expect(await reopened.attachmentTransfers.get(original.descriptor.id)).toEqual(progressed);
    expect(await reopened.attachmentTransfers.replace(0, { ...progressed, error: null })).toBe(
      false,
    );
  });

  it('isolates progress, auth resumption, cancellation and file cleanup between accounts', async () => {
    const a = (await openStore('a')).attachmentTransfers;
    const b = (await openStore('b')).attachmentTransfers;
    const original = attachment();
    await a.enqueue(original);
    expect(await b.list()).toEqual([]);
    expect(await b.get(original.descriptor.id)).toBeNull();
    expect(await b.replace(0, { ...original, revision: 1 })).toBe(false);
    await b.cancel(original.descriptor.id);
    await a.replace(0, { ...original, revision: 1, state: 'auth_required', error: 'auth' });
    await b.resumeAfterAuthentication();
    expect((await a.get(original.descriptor.id))!.state).toBe('auth_required');
    await a.resumeAfterAuthentication();
    expect(await a.get(original.descriptor.id)).toMatchObject({
      revision: 2,
      state: 'queued',
      error: null,
    });
    await a.cancel(original.descriptor.id);
    expect(await b.pendingFileRemovals()).toEqual([]);
    await b.acknowledgeFileRemoval(original.descriptor.id);
    expect(await a.pendingFileRemovals()).toEqual([
      { id: original.descriptor.id, localUri: original.localUri },
    ]);
  });

  it('erases transfer metadata on parent purge and durably queues file removal without resurrection', async () => {
    const store = await openStore('a');
    const parent = note();
    await store.merge([parent], parent.version);
    const original = attachment(parent.id),
      other = attachment();
    await store.attachmentTransfers.enqueue(original);
    await store.attachmentTransfers.enqueue(other);
    await store.merge([], 9, [{ id: parent.id, version: 9, purgedAt: new Date().toISOString() }]);
    expect(await store.attachmentTransfers.list()).toEqual([other]);
    expect(
      await store.attachmentTransfers.replace(0, { ...original, revision: 1, state: 'ready' }),
    ).toBe(false);
    await expect(store.attachmentTransfers.enqueue(original)).rejects.toThrow(
      'permanently deleted',
    );
    await expect(store.attachmentTransfers.enqueue(attachment(parent.id))).rejects.toThrow(
      'permanently deleted',
    );
    const reopened = (await openStore('a')).attachmentTransfers;
    expect(await reopened.pendingFileRemovals()).toEqual([
      { id: original.descriptor.id, localUri: original.localUri },
    ]);
    await reopened.acknowledgeFileRemoval(original.descriptor.id);
    expect(await reopened.pendingFileRemovals()).toEqual([]);
    const serializedRows = database.prepare('SELECT data FROM attachment_transfers').all();
    expect(JSON.stringify(serializedRows)).not.toContain(original.descriptor.id);
  });

  it('handles attachment tombstones and cancellation idempotently, reserving cancelled IDs', async () => {
    const store = await openStore('a');
    const original = attachment();
    await store.attachmentTransfers.enqueue(original);
    await store.attachmentTransfers.cancel(original.descriptor.id);
    await store.attachmentTransfers.cancel(original.descriptor.id);
    await store.merge([], 1, [
      { id: original.descriptor.id, version: 1, purgedAt: new Date().toISOString() },
    ]);
    expect(await store.attachmentTransfers.pendingFileRemovals()).toHaveLength(1);
    await store.attachmentTransfers.acknowledgeFileRemoval(original.descriptor.id);
    await expect(store.attachmentTransfers.enqueue(original)).rejects.toThrow(
      'permanently deleted',
    );
    expect(await store.attachmentTransfers.list()).toEqual([]);
  });

  it('rejects ID reuse and identity changes while preserving the original transfer', async () => {
    const store = (await openStore('a')).attachmentTransfers;
    const original = attachment();
    await store.enqueue(original);
    await expect(
      store.enqueue({
        ...original,
        descriptor: { ...original.descriptor, sha256: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('already in use');
    await expect(
      store.replace(0, { ...original, revision: 1, localUri: 'file:///different-user' }),
    ).rejects.toThrow('identity cannot change');
    await expect(store.replace(0, { ...original, revision: 2 })).rejects.toThrow(
      'Invalid transfer revision',
    );
    await expect(store.enqueue({ ...attachment(), state: 'ready' })).rejects.toThrow(
      'Only a new transfer',
    );
    expect(await store.get(original.descriptor.id)).toEqual(original);
  });

  it('rolls back file-removal scheduling and parent erasure when the enclosing sync transaction fails', async () => {
    const store = await openStore('a');
    const parent = note(),
      original = attachment(parent.id);
    await store.merge([parent], parent.version);
    await store.attachmentTransfers.enqueue(original);
    database.exec(
      `CREATE TRIGGER fail_purge BEFORE INSERT ON tombstones BEGIN SELECT RAISE(ABORT,'disk full'); END;`,
    );
    await expect(
      store.merge([], 8, [{ id: parent.id, version: 8, purgedAt: new Date().toISOString() }]),
    ).rejects.toThrow('disk full');
    expect(await store.attachmentTransfers.get(original.descriptor.id)).toEqual(original);
    expect(await store.attachmentTransfers.pendingFileRemovals()).toEqual([]);
    expect((await store.list()).map((record) => record.id)).toEqual([parent.id]);
    expect(await store.cursor()).toBe(parent.version);
  });

  it('prevents cleanup of one attachment from deleting another upload that shares its URI', async () => {
    const store = (await openStore('a')).attachmentTransfers;
    const original = attachment();
    const other = { ...attachment(), localUri: original.localUri };
    await store.enqueue(original);
    await expect(store.enqueue(other)).rejects.toThrow('own durable local file');
    await store.cancel(original.descriptor.id);
    await expect(store.enqueue(other)).rejects.toThrow('own durable local file');
    await store.acknowledgeFileRemoval(original.descriptor.id);
    await store.enqueue(other);
    expect(await store.list()).toEqual([other]);
  });
});

describe('cache upgrades and deletion replay', () => {
  it('keeps source drafts until a copy is acknowledged and prevents duplicate/purged-source copies', async () => {
    const store = await openStore('a');
    const source = note();
    const content = plainTextDocument('Recovered formatted draft');
    await store.merge([source], source.version);
    await store.saveDraft(source.id, { content, baseVersion: source.version });
    const failed: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.updateContent',
        id: source.id,
        contentJson: content,
        contentSchemaVersion: 1,
        baseVersion: source.version,
      },
    };
    await store.enqueue(failed, { ...source, text: 'Recovered formatted draft' }, source);
    await store.reject(failed.mutationId, 'Version conflict');
    const copy = {
      ...source,
      id: v7(),
      recoveredFromId: source.id,
      version: 0,
      contentJson: content,
    };
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.copyDraft',
        id: copy.id,
        sourceId: source.id,
        sourceBaseVersion: source.version,
        contentJson: content,
        contentSchemaVersion: 1,
      },
    };
    await store.enqueue(mutation, copy);
    expect(await store.loadDraft(source.id)).not.toBeNull();
    await expect(store.enqueue({ ...mutation, mutationId: v7() }, copy)).rejects.toThrow(
      'existing draft copy',
    );
    await store.acknowledge(mutation.mutationId, [{ ...copy, version: 7 }]);
    expect(await store.loadDraft(source.id)).toBeNull();
    expect(await store.problems()).toEqual([]);
    await store.saveDraft(source.id, { content, baseVersion: source.version });
    const another = { ...copy, id: v7() };
    const queued: Mutation = {
      ...mutation,
      mutationId: v7(),
      command: { ...mutation.command, id: another.id } as Mutation['command'],
    };
    await store.enqueue(queued, another);
    await store.merge([], 9, [{ id: source.id, version: 9, purgedAt: new Date().toISOString() }]);
    expect(await store.pending()).toEqual([]);
    expect((await store.list()).map((r) => r.id)).toEqual([copy.id]);
    await expect(store.enqueue(queued, another)).rejects.toThrow(
      'original note was permanently deleted',
    );
  });
  it('preserves a newer source draft when an earlier copy arrives', async () => {
    const store = await openStore('a');
    const source = note();
    await store.merge([source], source.version);
    const copied = plainTextDocument('Earlier draft');
    const newer = plainTextDocument('Newer draft');
    const copy = { ...source, id: v7(), recoveredFromId: source.id, version: 0 };
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.copyDraft',
        id: copy.id,
        sourceId: source.id,
        sourceBaseVersion: source.version,
        contentJson: copied,
        contentSchemaVersion: 1,
      },
    };
    await store.enqueue(mutation, copy);
    await store.saveDraft(source.id, { content: newer, baseVersion: source.version });
    await store.acknowledge(mutation.mutationId, [{ ...copy, version: 8 }]);
    expect((await store.loadDraft(source.id))?.content).toEqual(newer);
  });
  it('resumes account-scoped recovery with queued edits and drafts intact, while old purges erase private copies', async () => {
    const store = await openStore('a');
    const other = await openStore('b');
    const saved = note();
    const deleted = note();
    await store.merge([saved, deleted], 50);
    await other.merge([saved], 12);
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.updateContent',
        id: saved.id,
        baseVersion: saved.version,
        contentJson: plainTextDocument('Offline edit'),
        contentSchemaVersion: 1,
      },
    };
    await store.saveDraft(saved.id, {
      baseVersion: saved.version,
      content: plainTextDocument('Offline edit'),
    });
    await store.saveDraft(deleted.id, {
      baseVersion: deleted.version,
      content: plainTextDocument('Erase me'),
    });
    await store.enqueue(mutation, { ...saved, text: 'Offline edit' }, saved);
    await store.beginRecovery();
    expect(await store.cursor()).toBe(0);
    expect(await store.pending()).toEqual([mutation]);
    expect(await other.recovering()).toBe(false);
    expect(await other.cursor()).toBe(12);
    await store.merge([{ ...saved, version: 60, text: 'Server edit' }], 60);
    const resumed = await openStore('a');
    expect(await resumed.recovering()).toBe(true);
    expect(await resumed.cursor()).toBe(60);
    expect((await resumed.list()).find((r) => r.id === saved.id)?.text).toBe('Offline edit');
    await resumed.merge([], 70, [
      { id: deleted.id, version: 70, purgedAt: '2025-01-01T00:00:00Z' },
    ]);
    await resumed.finishRecovery();
    expect(await resumed.recovering()).toBe(false);
    expect(await resumed.pending()).toEqual([mutation]);
    expect(await resumed.loadDraft(saved.id)).not.toBeNull();
    expect(await resumed.loadDraft(deleted.id)).toBeNull();
    expect((await other.list())[0]?.text).toBe(saved.text);
  });
  it('asks the mobile scope chooser for recurring edits and preserves cancellation', async () => {
    const choose = vi
      .fn<() => Promise<'occurrence' | 'future' | null>>()
      .mockResolvedValue('future');
    const store = await openStore('a', choose);
    const task = recordSchema.parse({
      ...note(),
      type: 'task',
      status: 'todo',
      recurrence: {
        ruleId: v7(),
        seriesId: v7(),
        settings: {
          frequency: 'DAILY',
          interval: 1,
          weekdays: [],
          lastDay: false,
          mode: 'fixed_schedule',
          anchorDate: '2026-01-01',
          anchorTime: null,
          timeMode: 'floating',
          timezone: 'Asia/Kolkata',
          endsOn: null,
          count: null,
        },
        rrule: 'FREQ=DAILY;INTERVAL=1',
        occurrenceDate: '2026-01-01',
        occurrenceNumber: 1,
        nextTaskId: null,
        advanced: false,
      },
    });
    await store.merge([task], task.version);
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'task.rename', id: task.id, text: 'Future title', baseVersion: task.version },
    };
    await store.enqueue(mutation, { ...task, text: 'Future title' }, task);
    expect(choose).toHaveBeenCalledWith(task);
    expect((await store.pending())[0]!.command).toMatchObject({ scope: 'future' });
    await store.acknowledge(mutation.mutationId, [
      { ...task, text: 'Future title', version: task.version + 1 },
    ]);
    choose.mockResolvedValue(null);
    await expect(store.enqueue({ ...mutation, mutationId: v7() })).rejects.toThrow('cancelled');
    expect(await store.pending()).toEqual([]);
    expect((await store.list())[0]!.text).toBe('Future title');
  });
  it('queues checkpoints without blocking saves, clearing drafts or hiding remote changes', async () => {
    const store = await openStore('a'),
      original = note();
    await store.merge([original], original.version);
    const content = plainTextDocument('Unfinished checkpoint');
    await store.saveDraft(original.id, { content, baseVersion: original.version });
    const checkpoint: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.checkpoint',
        id: original.id,
        contentJson: content,
        contentSchemaVersion: 1,
        baseVersion: original.version,
        reason: 'interval',
      },
    };
    await store.enqueue(checkpoint);
    const remote = { ...original, version: original.version + 1, text: 'Other device' };
    await store.merge([remote], remote.version);
    expect(await store.list()).toEqual([remote]);
    await store.acknowledge(checkpoint.mutationId, []);
    expect(await store.loadDraft(original.id)).toEqual({ content, baseVersion: original.version });
    const next = { ...checkpoint, mutationId: v7() };
    await store.enqueue(next);
    const save: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.updateContent',
        id: original.id,
        contentJson: content,
        contentSchemaVersion: 1,
        baseVersion: remote.version,
      },
    };
    await store.enqueue(
      save,
      { ...remote, text: 'Unfinished checkpoint', contentJson: content },
      remote,
    );
    expect(await store.pending()).toEqual([next, save]);
    await expect(store.enqueue({ ...checkpoint, mutationId: v7() })).rejects.toThrow(
      'pending change',
    );
    await store.merge([], remote.version + 1, [
      { id: original.id, version: remote.version + 1, purgedAt: new Date().toISOString() },
    ]);
    expect(await store.pending()).toEqual([]);
    expect(await store.loadDraft(original.id)).toBeNull();
  });
  it('backfills search for pre-existing caches without duplicating entries on reopen', async () => {
    const existing = { ...note(), text: 'Legacy marigold' };
    database.exec(
      'CREATE TABLE records (user_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,id))',
    );
    database
      .prepare('INSERT INTO records VALUES (?,?,?)')
      .run('a', existing.id, JSON.stringify(existing));
    const store = await openStore('a');
    expect(
      (await store.search(searchQuerySchema.parse({ q: 'marigold' }))).groups.flatMap(
        (g) => g.records,
      ),
    ).toEqual([existing]);
    await openStore('a');
    expect(database.prepare('SELECT count(*) AS total FROM record_search').get()).toMatchObject({
      total: 1,
    });
  });
  it('searches SQLite prefixes, accents, Hindi, descriptions and tags with account/filter isolation', async () => {
    const a = await openStore('a');
    const b = await openStore('b');
    const projectId = v7();
    const folderId = v7();
    const task = {
      ...note(),
      type: 'task' as const,
      status: 'todo' as const,
      text: 'Prepare café presentation',
      tags: ['work'],
      projectId,
      descriptionJson: plainTextDocument('Budget समीक्षा'),
    };
    const archived = {
      ...note(),
      text: 'Presentation history',
      folderId,
      archivedAt: new Date().toISOString(),
    };
    await a.merge([task, archived], 3);
    const find = async (q: string, extra = {}) =>
      (await a.search(searchQuerySchema.parse({ q, limit: 20, ...extra }))).groups.flatMap(
        (g) => g.records,
      );
    expect(await find('cafe pres')).toEqual([task]);
    expect(await find('समीक्षा')).toEqual([task]);
    expect(await find('budg', { tag: 'work', projectId, type: 'task', status: 'todo' })).toEqual([
      task,
    ]);
    expect(await find('budg', { projectId: v7() })).toEqual([]);
    expect(await find('work')).toEqual([task]);
    expect(await find('pres', { type: 'note' })).toEqual([]);
    expect(await find('pres', { type: 'note', includeArchived: true, folderId })).toEqual([
      archived,
    ]);
    expect(
      (await b.search(searchQuerySchema.parse({ q: 'presentation' }))).groups.flatMap(
        (g) => g.records,
      ),
    ).toEqual([]);
    expect(await find('" OR * - ()')).toEqual([]);
    expect(await find('cafe', { from: '2000-01-01', to: '2000-12-31' })).toEqual([]);
    const reopened = await openStore('a');
    expect(
      (await reopened.search(searchQuerySchema.parse({ q: 'cafe' }))).groups.flatMap(
        (g) => g.records,
      ),
    ).toEqual([task]);
  });
  it('updates the search index on optimistic writes, rollback, Trash and purge, and ignores stale remote search', async () => {
    const store = await openStore('a');
    const original = { ...note(), text: 'Private orchid' };
    const query = searchQuerySchema.parse({ q: 'orchid' });
    const results = async () => (await store.search(query)).groups.flatMap((g) => g.records);
    await store.merge([original], 3);
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'note.edit', id: original.id, text: 'Different flower', baseVersion: 3 },
    };
    await store.enqueue(mutation, { ...original, text: 'Different flower' }, original);
    expect(await results()).toEqual([]);
    expect(
      (await store.cacheSearch({ groups: [{ type: 'note', records: [original], hasMore: false }] }))
        .groups[0]!.records,
    ).toEqual([]);
    await store.reject(mutation.mutationId, 'Conflict');
    expect(await results()).toEqual([original]);
    await store.merge([{ ...original, version: 4, deletedAt: new Date().toISOString() }], 4);
    expect(await results()).toEqual([]);
    expect(
      (await store.cacheSearch({ groups: [{ type: 'note', records: [original], hasMore: false }] }))
        .groups[0]!.records,
    ).toEqual([]);
    await store.merge([], 5, [{ id: original.id, version: 5, purgedAt: new Date().toISOString() }]);
    await store.cacheSearch({
      groups: [{ type: 'note', records: [{ ...original, version: 9 }], hasMore: false }],
    });
    expect(await results()).toEqual([]);
    expect(await store.cursor()).toBe(5);
    expect(database.prepare('SELECT * FROM record_search').all()).toEqual([]);
  });
  it('replaces a daily placeholder with the existing note from another device', async () => {
    const store = await openStore('a');
    const placeholder = { ...note(0), kind: 'daily' as const, dailyDate: '2026-10-02' };
    const existing = { ...placeholder, id: v7(), version: 4, text: 'Already written elsewhere' };
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'note.openDaily', id: placeholder.id, date: placeholder.dailyDate },
    };
    await store.enqueue(mutation, placeholder);
    await store.acknowledge(mutation.mutationId, [existing]);
    expect(await store.list()).toEqual([existing]);
    const afterPurge = { ...placeholder, id: v7() };
    const retry: Mutation = {
      mutationId: v7(),
      command: { op: 'note.openDaily', id: afterPurge.id, date: afterPurge.dailyDate },
    };
    await store.enqueue(retry, afterPurge);
    await store.acknowledge(retry.mutationId, []);
    expect(await store.list()).toEqual([existing]);
    expect(await store.pending()).toEqual([]);
    await store.acknowledge(mutation.mutationId, [existing]);
    expect(await store.list()).toEqual([existing]);
  });
  it('acknowledges task description drafts without deleting a newer draft', async () => {
    const store = await openStore('a');
    const task = { ...note(), type: 'task' as const };
    const content = plainTextDocument('Steps');
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'task.updateDescription',
        id: task.id,
        baseVersion: task.version,
        contentJson: content,
        contentSchemaVersion: 1,
      },
    };
    await store.saveDraft(task.id, { content, baseVersion: task.version });
    await store.enqueue(mutation, { ...task, descriptionJson: content }, task);
    await store.acknowledge(mutation.mutationId, [
      { ...task, descriptionJson: content, version: 4 },
    ]);
    expect(await store.loadDraft(task.id)).toBeNull();
    const newer = plainTextDocument('More steps');
    await store.saveDraft(task.id, { content: newer, baseVersion: 4 });
    await store.acknowledge(mutation.mutationId, [
      { ...task, descriptionJson: content, version: 4 },
    ]);
    expect((await store.loadDraft(task.id))!.content).toEqual(newer);
  });
  it('removes a rejected optimistic folder when the user dismisses its sync error', async () => {
    const store = await openStore('a');
    const folder = { ...note(0), type: 'folder' as const, text: 'Too deep' };
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'folder.create', id: folder.id, name: folder.text, parentId: v7() },
    };
    await store.enqueue(mutation, folder);
    await store.reject(mutation.mutationId, 'Folders can be nested up to three levels.');
    expect(await store.problems()).toHaveLength(1);
    await store.dismissProblem(mutation.mutationId);
    expect(await store.list()).toEqual([]);
  });
  it('caches history for offline reading, isolates accounts, and erases it on purge', async () => {
    const a = await openStore('a');
    const b = await openStore('b');
    const original = note();
    const snapshot = {
      id: v7(),
      noteId: original.id,
      version: 3,
      title: 'Earlier content',
      contentJson: plainTextDocument('Earlier content'),
      contentSchemaVersion: 1 as const,
      reason: 'session_end' as const,
      createdAt: new Date().toISOString(),
    };
    await a.cacheHistory(original.id, [snapshot]);
    expect(await (await openStore('a')).history(original.id)).toEqual([snapshot]);
    expect(await b.history(original.id)).toEqual([]);
    await a.merge([], 4, [{ id: original.id, version: 4, purgedAt: new Date().toISOString() }]);
    await a.cacheHistory(original.id, [snapshot]);
    expect(await a.history(original.id)).toEqual([]);
  });
  it('reads pre-priority/archive cache and rollback snapshots without dropping data', async () => {
    const store = await openStore('a');
    const original = note();
    const legacy = { ...original } as Partial<RecordItem>;
    for (const key of [
      'dueDate',
      'priority',
      'pinned',
      'favorite',
      'archivedAt',
      'parentId',
      'tags',
    ] as const)
      delete legacy[key];
    database
      .prepare('INSERT INTO records(user_id,id,data) VALUES (?,?,?)')
      .run('a', original.id, JSON.stringify(legacy));
    expect(await store.list()).toEqual([original]);
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'note.edit', id: original.id, text: 'Edit', baseVersion: 3 },
    };
    database
      .prepare('INSERT INTO outbox(user_id,id,mutation,previous) VALUES (?,?,?,?)')
      .run('a', mutation.mutationId, JSON.stringify(mutation), JSON.stringify(legacy));
    await store.reject(mutation.mutationId, 'Conflict');
    expect(await store.list()).toEqual([original]);
  });

  it('applies remote purge atomically, erases private copies, and blocks delayed resurrection across restart', async () => {
    const a = await openStore('a');
    const b = await openStore('b');
    const original = note();
    await a.merge([original], 3);
    await b.merge([original], 3);
    await a.saveDraft(original.id, { content: plainTextDocument('Private draft'), baseVersion: 3 });
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'note.edit', id: original.id, text: 'Private edit', baseVersion: 3 },
    };
    await a.enqueue(mutation, { ...original, text: 'Private edit' }, original);
    await a.merge([], 4, [{ id: original.id, version: 4, purgedAt: new Date().toISOString() }]);
    expect(await a.list()).toEqual([]);
    expect(await a.loadDraft(original.id)).toBeNull();
    expect(await a.pending()).toEqual([]);
    expect(await a.cursor()).toBe(4);
    const reopened = await openStore('a');
    await reopened.acknowledge(mutation.mutationId, [original]);
    await reopened.merge([original], 5);
    expect(await reopened.list()).toEqual([]);
    await expect(reopened.enqueue(mutation, original)).rejects.toThrow('permanently deleted');
    await expect(
      reopened.saveDraft(original.id, { content: plainTextDocument('Late draft'), baseVersion: 3 }),
    ).rejects.toThrow('permanently deleted');
    expect(await b.list()).toEqual([original]);
  });

  it('does not replace newer server state with an old idempotency response', async () => {
    const store = await openStore('a');
    const original = note();
    await store.merge([{ ...original, version: 8, text: 'Latest' }], 8);
    await store.acknowledge(v7(), [original]);
    expect((await store.list())[0]?.text).toBe('Latest');
  });

  it('prevents overlapping mutations and preserves optimism during a pull', async () => {
    const store = await openStore('a');
    const original = note();
    const mutation: Mutation = {
      mutationId: v7(),
      command: { op: 'note.edit', id: original.id, text: 'My edit', baseVersion: 3 },
    };
    await store.enqueue(mutation, { ...original, text: 'My edit' }, original);
    await expect(
      store.enqueue({ ...mutation, mutationId: v7() }, original, original),
    ).rejects.toThrow('pending change');
    await store.merge([{ ...original, version: 4, text: 'Remote edit' }], 4);
    expect((await store.list())[0]?.text).toBe('My edit');
    await store.reject(mutation.mutationId, 'Conflict');
    expect(await store.cursor()).toBe(0);
    await store.merge([{ ...original, version: 4, text: 'Remote edit' }], 4);
    expect((await store.list())[0]?.text).toBe('Remote edit');
  });
});

describe('durable formatted-note drafts', () => {
  it('recovers drafts when reopening the store and isolates accounts', async () => {
    const a = await openStore('a');
    const id = v7();
    const draft = { content: plainTextDocument('Unsynced draft नमस्ते'), baseVersion: 3 };
    await a.saveDraft(id, draft);
    expect(await (await openStore('a')).loadDraft(id)).toEqual(draft);
    const b = await openStore('b');
    expect(await b.loadDraft(id)).toBeNull();
    await b.discardDraft(id);
    expect(await a.loadDraft(id)).toEqual(draft);
  });
  it('preserves a conflicting edit while restoring the last accepted record', async () => {
    const store = await openStore('a');
    const id = v7();
    const now = new Date().toISOString();
    const original = recordSchema.parse({
      id,
      type: 'note',
      text: 'Original',
      status: 'active',
      plannedDate: null,
      dueDate: null,
      priority: 0,
      parentId: null,
      pinned: false,
      favorite: false,
      archivedAt: null,
      tags: [],
      version: 3,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const content = plainTextDocument('Local edit');
    const mutation: Mutation = {
      mutationId: v7(),
      command: {
        op: 'note.updateContent',
        id,
        contentJson: content,
        contentSchemaVersion: 1,
        baseVersion: 3,
      },
    };
    await store.saveDraft(id, { content, baseVersion: 3 });
    await store.enqueue(
      mutation,
      { ...original, text: 'Local edit', contentJson: content },
      original,
    );
    await store.reject(mutation.mutationId, 'Changed on another device');
    expect((await store.list())[0]?.text).toBe('Original');
    expect(await store.loadDraft(id)).toEqual({ content, baseVersion: 3 });
    await store.dismissProblem(mutation.mutationId);
    expect(await store.loadDraft(id)).not.toBeNull();
  });
  it('clears only the acknowledged draft and removes drafts after permanent deletion', async () => {
    const store = await openStore('a');
    const id = v7();
    const content = plainTextDocument('First edit');
    const command = {
      op: 'note.updateContent' as const,
      id,
      contentJson: content,
      contentSchemaVersion: 1 as const,
      baseVersion: 3,
    };
    const first = v7();
    await store.saveDraft(id, { content, baseVersion: 3 });
    await store.enqueue({ mutationId: first, command });
    const newer = { content: plainTextDocument('Newer edit'), baseVersion: 3 };
    await store.saveDraft(id, newer);
    await store.acknowledge(first, []);
    expect(await store.loadDraft(id)).toEqual(newer);
    const second = v7();
    await store.enqueue({
      mutationId: second,
      command: { ...command, contentJson: newer.content },
    });
    await store.acknowledge(second, []);
    expect(await store.loadDraft(id)).toBeNull();
    await store.saveDraft(id, newer);
    const purge = v7();
    await store.enqueue({ mutationId: purge, command: { op: 'note.purge', id, baseVersion: 4 } });
    await store.acknowledge(purge, []);
    expect(await store.loadDraft(id)).toBeNull();
  });
});
