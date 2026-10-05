import { ApiError, createAttachmentTransport, type createClient } from '@personalspace/api-client';
import { createAttachmentTransferEngine, type AttachmentDrainResult } from '@personalspace/sync';
import type { LocalStore } from './store';
import type { AttachmentFiles } from './attachment-files';
import { createAttachmentCache } from './attachment-cache';
import { createThumbnailPrefetcher, recentThumbnails } from './thumbnail-prefetch';

export function createAttachmentRuntime(options: {
  store: LocalStore;
  client: ReturnType<typeof createClient>;
  files: AttachmentFiles;
  onRemoteChange: () => void;
}) {
  const { store, files, client } = options;
  const transfers = store.attachmentTransfers;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const emit = () => {
    if (!lifetime.signal.aborted) for (const listener of listeners) listener();
  };
  let active = false,
    cellular = false,
    running: Promise<void> | null = null,
    again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;
  let network = { connected: false, wifi: false };
  let state: AttachmentDrainResult = {
    nextAttemptAt: null,
    waitingForNetwork: true,
    waitingForWifi: false,
    authenticationRequired: false,
  };
  let changed = false;
  const live = async (parentId: string) =>
    (await store.list()).some(
      (row) => row.id === parentId && row.type === 'note' && !row.deletedAt && row.version > 0,
    );
  const permitted = async (id: string) => {
    if ((await transfers.removedIds()).includes(id)) return false;
    const remote = (await store.list()).find(
      (item) => item.id === id && item.type === 'attachment',
    );
    const local = await transfers.get(id);
    if (remote?.deletedAt || remote?.attachment?.status === 'rejected') return false;
    // A successful completion response can precede the ready metadata row.
    if (remote?.attachment?.status !== 'ready' && local?.state !== 'ready') return false;
    const parentId =
      remote?.parentId ?? (local?.state === 'ready' ? local.descriptor.parentId : null);
    return !!parentId && (await live(parentId));
  };
  const cache = createAttachmentCache({
    store: store.attachmentCache,
    files,
    signal: lifetime.signal,
    permitted,
    connected: () => network.connected,
    grant: (id, variant) => client.downloadAttachment(id, variant),
    onChange: emit,
  });
  let recovery: Promise<void> | null = null;
  const thumbnails = createThumbnailPrefetcher({
    enabled: () =>
      active && network.connected && !lifetime.signal.aborted && !state.authenticationRequired,
    candidates: async () =>
      recentThumbnails(
        await store.list(),
        await store.attachmentCache.list(),
        await transfers.removedIds(),
        Date.now(),
      ),
    fetch: cache.prefetchThumbnail,
    retry: (error) => {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        state.authenticationRequired = true;
        emit();
        return null;
      }
      return error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
    },
  });
  const recoverOriginals = () => {
    if (!recovery)
      recovery = (async () => {
        const jobs = await transfers.list(),
          removals = await transfers.pendingFileRemovals();
        lifetime.signal.throwIfAborted();
        await files.reclaimOriginals([
          ...jobs.map((job) => job.localUri),
          ...removals.map((item) => item.localUri),
        ]);
      })().catch((error) => {
        recovery = null;
        throw error;
      });
    return recovery;
  };
  const makeEngine = () =>
    createAttachmentTransferEngine({
      store: {
        list: async () => {
          const parents = new Set(
            (await store.list())
              .filter((row) => row.type === 'note' && !row.deletedAt && row.version > 0)
              .map((row) => row.id),
          );
          return (await transfers.list()).filter((job) => parents.has(job.descriptor.parentId));
        },
        get: async (id) => {
          const job = await transfers.get(id);
          return job && (await live(job.descriptor.parentId)) ? job : null;
        },
        replace: async (revision, next) => {
          const result = await transfers.replace(revision, next);
          if (result) {
            changed = true;
            emit();
          }
          return result;
        },
      },
      transport: createAttachmentTransport(client, files.put),
      inspect: files.inspect,
      network: () => ({ ...network, connected: active && network.connected }),
      wifiOnlyForLargeFiles: () => !cellular,
    });
  let engine = makeEngine();
  const resetEngine = () => {
    engine.dispose();
    engine = makeEngine();
  };
  const schedule = (at: number) => {
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    if (active && !lifetime.signal.aborted)
      timer = setTimeout(
        () => {
          timer = null;
          timerAt = Infinity;
          void request();
        },
        Math.max(100, Math.min(2147483647, at - Date.now())),
      );
  };
  async function request() {
    if (lifetime.signal.aborted) return;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await recoverOriginals().catch(() => schedule(Date.now() + 30000));
          // Cache operations may await a share sheet. Never make uploads/row sync wait for it.
          void cache
            .maintain()
            .then(() => thumbnails.request())
            .catch(() => schedule(Date.now() + 30000));
          for (const item of await transfers.pendingFileRemovals()) {
            try {
              await files.remove(item.localUri);
              await transfers.acknowledgeFileRemoval(item.id);
            } catch {
              schedule(Date.now() + 30000);
            }
          }
          if (!active || lifetime.signal.aborted) break;
          if (network.connected) {
            for (const item of await transfers.pendingRemoteRemovals()) {
              if (!active || lifetime.signal.aborted) break;
              try {
                await client.removeAttachment(item.id);
                await transfers.acknowledgeRemoteRemoval(item.id);
                changed = true;
              } catch (error) {
                if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
                schedule(Date.now() + 30000);
              }
            }
          }
          state = await engine.drain();
          void thumbnails.request();
          if (state.nextAttemptAt) schedule(state.nextAttemptAt);
          if ((await transfers.pendingRemoteRemovals()).length) schedule(Date.now() + 30000);
          if (changed) {
            changed = false;
            options.onRemoteChange();
          }
        } catch (error) {
          if (error instanceof ApiError && [401, 403].includes(error.status))
            state.authenticationRequired = true;
          else schedule(Date.now() + 30000);
        }
        emit();
      } while (again && active && !lifetime.signal.aborted);
    })().finally(() => {
      running = null;
    });
    return running;
  }
  const unwatch = files.watchNetwork((value) => {
    network = value;
    if (!value.connected) thumbnails.interrupt();
    void request();
    emit();
  });
  return {
    request,
    status: () => ({ ...state, connected: network.connected, wifi: network.wifi, cellular }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActive: (value: boolean) => {
      active = value;
      if (!value) {
        thumbnails.interrupt();
        resetEngine();
        if (timer) clearTimeout(timer);
        timer = null;
      } else {
        thumbnails.resume();
        void request();
      }
    },
    setCellular: (value: boolean) => {
      cellular = value;
      void request();
      emit();
    },
    pick: async (parentId: string) => {
      await recoverOriginals();
      lifetime.signal.throwIfAborted();
      if (!(await live(parentId)))
        throw new Error('Sync or restore this note before adding a file.');
      const job = await files.pick(parentId, lifetime.signal);
      if (!job) return;
      try {
        lifetime.signal.throwIfAborted();
        if (!(await live(parentId))) throw new Error('This note is no longer available.');
        await transfers.enqueue(job);
      } catch (error) {
        // Never erase a file if persistence succeeded but a later step failed.
        if (!(await transfers.get(job.descriptor.id))) await files.remove(job.localUri);
        throw error;
      }
      emit();
      void request();
    },
    retry: async (id: string) => {
      await transfers.retry(id);
      emit();
      void request();
    },
    remove: async (id: string) => {
      resetEngine();
      await transfers.requestRemoval(id);
      emit();
      void request();
    },
    share: cache.share,
    previewImage: cache.preview,
    keepOffline: async (id: string) => {
      await cache.pin(id);
      const record = (await store.list()).find(
        (item) => item.id === id && item.type === 'attachment',
      );
      if (record?.attachment?.hasThumbnail) await cache.pinPreview(id);
    },
    unpin: cache.unpin,
    storageUsage: cache.usage,
    clearCache: async () => {
      thumbnails.pause();
      await cache.clear();
    },
    setCacheLimitMb: cache.setLimitMb,
    dispose: () => {
      thumbnails.dispose();
      lifetime.abort();
      active = false;
      engine.dispose();
      unwatch();
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
  };
}
export type AttachmentRuntime = ReturnType<typeof createAttachmentRuntime>;
