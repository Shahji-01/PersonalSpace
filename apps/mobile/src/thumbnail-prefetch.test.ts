import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordSchema } from '@personalspace/validation';
import { v7 } from 'uuid';
import {
  createThumbnailPrefetcher,
  recentThumbnails,
  THUMBNAIL_WINDOW_MS,
} from './thumbnail-prefetch';

afterEach(() => vi.useRealTimers());

describe('recent thumbnail selection', () => {
  it('selects only live synced recent images, newest first, excluding cached and locally removed files', () => {
    const now = Date.now();
    const parent = recordSchema.parse({
      id: v7(),
      type: 'note',
      text: 'Note',
      version: 1,
      status: 'active',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      plannedDate: null,
      deletedAt: null,
    });
    const file = (age: number) => {
      const id = v7();
      return recordSchema.parse({
        ...parent,
        id,
        type: 'attachment',
        parentId: parent.id,
        createdAt: new Date(now - age).toISOString(),
        attachment: {
          id,
          parentId: parent.id,
          filename: 'photo.webp',
          mime: 'image/webp',
          processedMime: 'image/webp',
          size: 10,
          sha256: 'a'.repeat(64),
          status: 'ready',
          hasThumbnail: true,
        },
      });
    };
    const fresh = file(0),
      boundary = file(THUMBNAIL_WINDOW_MS),
      old = file(THUMBNAIL_WINDOW_MS + 1),
      future = file(-1),
      removed = file(10),
      cached = file(10),
      processing = file(10),
      unsynced = file(10),
      trashed = file(10),
      foreign = file(10);
    processing.attachment!.status = 'processing';
    unsynced.version = 0;
    trashed.deletedAt = new Date(now).toISOString();
    foreign.parentId = v7();
    const records = [
      parent,
      old,
      boundary,
      fresh,
      future,
      removed,
      cached,
      processing,
      unsynced,
      trashed,
      foreign,
    ];
    const entries = [
      {
        id: cached.id,
        variant: 'thumbnail' as const,
        uri: 'file:///cached',
        mime: 'image/webp',
        size: 10,
        sha256: 'a'.repeat(64),
        pinned: false,
        accessedAt: 1,
      },
    ];
    expect(recentThumbnails(records, entries, [removed.id], now)).toEqual([fresh.id, boundary.id]);
    parent.deletedAt = new Date(now).toISOString();
    expect(recentThumbnails(records, entries, [], now)).toEqual([]);
  });
});

describe('foreground thumbnail scheduling', () => {
  it('honors provider retry delays and pauses the batch on authentication failure', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => {
      throw new Error('retry');
    });
    let delay: number | null = 10 * 60 * 1000;
    const runner = createThumbnailPrefetcher({
      enabled: () => true,
      candidates: async () => ['one', 'two'],
      fetch,
      retry: () => delay,
    });
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    delay = null;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await runner.request();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    runner.dispose();
  });
  it('downloads in bounded batches, skips recent failures and continues with other images', async () => {
    vi.useFakeTimers();
    const pending = new Set(Array.from({ length: 22 }, (_, i) => String(i)));
    let fail = true;
    const fetch = vi.fn(async (id: string) => {
      if (id === '0' && fail) throw new Error('offline');
      pending.delete(id);
      return 'cached' as const;
    });
    const runner = createThumbnailPrefetcher({
      enabled: () => true,
      candidates: async () => [...pending],
      fetch,
    });
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(22);
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(22);
    fail = false;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(23);
    expect(pending.size).toBe(0);
    runner.dispose();
  });
  it('pauses after cache clear and capacity exhaustion, and cancels on interruption or disposal', async () => {
    vi.useFakeTimers();
    let online = false;
    const fetch = vi.fn(async () => 'full' as 'full' | 'cached');
    const runner = createThumbnailPrefetcher({
      enabled: () => online,
      candidates: async () => ['one', 'two'],
      fetch,
    });
    await runner.request();
    expect(fetch).not.toHaveBeenCalled();
    online = true;
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(1);
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(1);
    runner.pause();
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(1);
    runner.resume();
    await runner.request();
    expect(fetch).toHaveBeenCalledTimes(2);
    runner.dispose();
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('coalesces requests and aborts an active download before starting another', async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    let online = true;
    const fetch = vi.fn(async (_id: string, current: AbortSignal) => {
      signal = current;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 'cached' as const;
    });
    const runner = createThumbnailPrefetcher({
      enabled: () => online,
      candidates: async () => ['one', 'two'],
      fetch,
    });
    const work = runner.request();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = runner.request();
    online = false;
    runner.interrupt();
    expect(signal!.aborted).toBe(true);
    finish();
    await Promise.all([work, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    runner.dispose();
  });
});
