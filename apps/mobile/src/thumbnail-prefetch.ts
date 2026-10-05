import type { RecordItem } from '@personalspace/validation';
import type { AttachmentCacheEntry } from './attachment-cache-store';

export const THUMBNAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 20;
const RETRY_MS = 5 * 60 * 1000;

export function recentThumbnails(
  records: RecordItem[],
  cached: AttachmentCacheEntry[],
  removed: string[],
  now: number,
): string[] {
  const parents = new Set(
    records
      .filter((row) => row.type === 'note' && !row.deletedAt && row.version > 0)
      .map((row) => row.id),
  );
  const unavailable = new Set([
    ...removed,
    ...cached.filter((entry) => entry.variant === 'thumbnail').map((entry) => entry.id),
  ]);
  return records
    .filter((row) => {
      const created = Date.parse(row.createdAt);
      return (
        row.type === 'attachment' &&
        row.version > 0 &&
        !row.deletedAt &&
        row.parentId &&
        parents.has(row.parentId) &&
        !unavailable.has(row.id) &&
        row.attachment?.status === 'ready' &&
        row.attachment.hasThumbnail &&
        row.attachment.processedMime === 'image/webp' &&
        created >= now - THUMBNAIL_WINDOW_MS &&
        created <= now
      );
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map((row) => row.id);
}

// One low-priority cache operation at a time; row sync and uploads never await it.
export function createThumbnailPrefetcher(options: {
  enabled: () => boolean;
  candidates: () => Promise<string[]>;
  fetch: (id: string, signal: AbortSignal) => Promise<'cached' | 'full'>;
  retry?: (error: unknown) => number | null;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const failures = new Map<string, number>();
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let paused = false,
    disposed = false,
    again = false;
  let capacityRetryAt = 0;
  const enabled = () => !disposed && !paused && options.enabled();
  const schedule = (delay: number) => {
    if (!enabled()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void request();
    }, delay);
  };
  async function request(): Promise<void> {
    if (!enabled()) return;
    if (running) {
      again = true;
      return running;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    running = (async () => {
      do {
        again = false;
        controller = new AbortController();
        const signal = controller.signal;
        try {
          if (capacityRetryAt > now()) {
            schedule(capacityRetryAt - now());
            break;
          }
          const ids = await options.candidates();
          if (signal.aborted || !enabled()) break;
          const eligible = new Set(ids);
          for (const id of failures.keys()) if (!eligible.has(id)) failures.delete(id);
          const due = ids.filter((id) => (failures.get(id) ?? 0) <= now());
          for (const id of due.slice(0, BATCH_SIZE)) {
            if (signal.aborted || !enabled()) break;
            try {
              const result = await options.fetch(id, signal);
              if (signal.aborted || !enabled()) break;
              if (result === 'full') {
                capacityRetryAt = now() + RETRY_MS;
                break;
              }
              failures.delete(id);
            } catch (error) {
              if (signal.aborted || !enabled()) break;
              const delay = options.retry ? options.retry(error) : RETRY_MS;
              if (delay === null) {
                paused = true;
                break;
              }
              failures.set(id, now() + Math.max(RETRY_MS, delay));
            }
          }
          if (capacityRetryAt > now()) schedule(capacityRetryAt - now());
          else if (due.length > BATCH_SIZE) schedule(1000);
          else if (failures.size) schedule(Math.max(1000, Math.min(...failures.values()) - now()));
        } catch {
          if (!signal.aborted) schedule(RETRY_MS);
        }
      } while (again && enabled());
    })().finally(() => {
      running = null;
      controller = null;
      if (again && enabled()) void request();
    });
    return running;
  }
  const stop = () => {
    controller?.abort();
    again = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    request,
    interrupt: stop,
    pause: () => {
      paused = true;
      stop();
    },
    resume: () => {
      paused = false;
      capacityRetryAt = 0;
      void request();
    },
    dispose: () => {
      disposed = true;
      stop();
      failures.clear();
    },
  };
}
