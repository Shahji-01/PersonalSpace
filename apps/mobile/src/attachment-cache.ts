import type { AttachmentFiles } from './attachment-files';
import type { AttachmentCacheEntry, AttachmentCacheStore } from './attachment-cache-store';

export function createAttachmentCache(options: {
  store: AttachmentCacheStore;
  files: AttachmentFiles;
  signal: AbortSignal;
  permitted: (id: string) => Promise<boolean>;
  connected: () => boolean;
  grant: (
    id: string,
  ) => Promise<{ url: string; mime: string; size: number; sha256: string | null }>;
  onChange: () => void;
}) {
  const { store, files, signal } = options;
  // Keep download writes, manifest commits, share sheets and eviction ordered.
  // Neither this queue nor its network work holds the row-sync SQLite transaction.
  let operations: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = operations.then(async () => {
      signal.throwIfAborted();
      try {
        return await work();
      } finally {
        options.onChange();
      }
    });
    operations = result.catch(() => {});
    return result;
  };
  const remove = async (entry: AttachmentCacheEntry) => {
    // A disk failure must retain metadata so deletion can be retried.
    await files.removeDownload(entry);
    await store.remove(entry.id);
  };
  const trim = async (clear = false) => {
    const entries = (await store.list()).sort(
      (a, b) => a.accessedAt - b.accessedAt || a.id.localeCompare(b.id),
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const cap = (await store.limitMb()) * 1024 * 1024;
    for (const entry of entries) {
      signal.throwIfAborted();
      if (!entry.pinned && (clear || total > cap)) {
        await remove(entry);
        total -= entry.size;
      }
    }
  };
  const ensure = async (id: string, pin: boolean, share: boolean) =>
    serial(async () => {
      if (!(await options.permitted(id))) throw new Error('This file is no longer available.');
      signal.throwIfAborted();
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 60000);
      try {
        let entry = (await store.list()).find((item) => item.id === id);
        const pinned = pin || !!entry?.pinned;
        if (entry && !(await files.verifyDownload(entry, controller.signal))) {
          await remove(entry);
          entry = undefined;
        }
        if (!entry) {
          if (!options.connected())
            throw new Error('Available when online. Connect to download this file.');
          const grant = await options.grant(id);
          controller.signal.throwIfAborted();
          const downloaded = await files.download(id, grant, controller.signal, () =>
            options.permitted(id),
          );
          entry = { ...downloaded, pinned, accessedAt: Date.now() };
        } else entry = { ...entry, pinned, accessedAt: Date.now() };
        if (!(await options.permitted(id))) {
          await remove(entry);
          throw new Error('This file is no longer available.');
        }
        controller.signal.throwIfAborted();
        await store.put(entry);
        // Keep the file until the OS share sheet closes, even when pins fill the cap.
        if (share)
          await files.shareDownloaded(entry, controller.signal, () => options.permitted(id));
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (!signal.aborted) await trim();
      }
    });
  let maintenance: Promise<void> | null = null;
  let maintainAgain = false;
  const maintain = () => {
    if (maintenance) {
      maintainAgain = true;
      return maintenance;
    }
    if (!maintenance)
      maintenance = serial(async () => {
        do {
          maintainAgain = false;
          for (const entry of await store.list()) {
            signal.throwIfAborted();
            // Trash/removal takes precedence over pinning.
            if (!(await options.permitted(entry.id)) || !(await files.hasDownload(entry)))
              await remove(entry);
          }
          await files.reconcileDownloads((await store.list()).map((entry) => entry.uri));
          await trim();
        } while (maintainAgain && !signal.aborted);
      }).finally(() => {
        maintenance = null;
      });
    return maintenance;
  };
  return {
    share: (id: string) => ensure(id, false, true),
    pin: (id: string) => ensure(id, true, false),
    unpin: (id: string) =>
      serial(async () => {
        const entry = (await store.list()).find((item) => item.id === id);
        if (entry) await store.put({ ...entry, pinned: false });
        await trim();
      }),
    clear: () => serial(() => trim(true)),
    setLimitMb: (limit: number) =>
      serial(async () => {
        await store.setLimitMb(limit);
        await trim();
      }),
    maintain,
    usage: async () => {
      const entries = await store.list();
      return {
        entries,
        downloadedBytes: entries.reduce((sum, item) => sum + item.size, 0),
        pinnedBytes: entries
          .filter((item) => item.pinned)
          .reduce((sum, item) => sum + item.size, 0),
        originalBytes: await files.originalBytes(),
        limitMb: await store.limitMb(),
      };
    },
  };
}
export type AttachmentCacheUsage = Awaited<
  ReturnType<ReturnType<typeof createAttachmentCache>['usage']>
>;
