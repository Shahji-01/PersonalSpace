import { ApiError, createAttachmentTransport, type createClient } from '@personalspace/api-client';
import { createAttachmentTransferEngine, type AttachmentDrainResult } from '@personalspace/sync';
import type { LocalStore } from './store';
import type { AttachmentFiles } from './attachment-files';

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
          const records = await store.list(),
            removed = new Set(await transfers.removedIds());
          const parents = new Set(
            records.filter((row) => row.type === 'note' && !row.deletedAt).map((row) => row.id),
          );
          const localReady = (await transfers.list())
            .filter(
              (job) =>
                job.state === 'ready' &&
                parents.has(job.descriptor.parentId) &&
                !removed.has(job.descriptor.id),
            )
            .map((job) => job.descriptor.id);
          await files
            .pruneDownloads(
              records
                .filter(
                  (row) =>
                    row.type === 'attachment' &&
                    !row.deletedAt &&
                    row.parentId &&
                    parents.has(row.parentId) &&
                    !removed.has(row.id),
                )
                .map((row) => row.id)
                .concat(localReady),
            )
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
        resetEngine();
        if (timer) clearTimeout(timer);
        timer = null;
      } else void request();
    },
    setCellular: (value: boolean) => {
      cellular = value;
      void request();
      emit();
    },
    pick: async (parentId: string) => {
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
    share: async (id: string) => {
      const controller = new AbortController(),
        abort = () => controller.abort();
      lifetime.signal.throwIfAborted();
      lifetime.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 60000);
      try {
        const permitted = async () => {
          if ((await transfers.removedIds()).includes(id)) return false;
          const remote = (await store.list()).find(
            (item) => item.id === id && item.type === 'attachment' && !item.deletedAt,
          );
          const local = await transfers.get(id);
          const parentId = remote?.parentId ?? local?.descriptor.parentId;
          return !!parentId && (await live(parentId));
        };
        if (!(await permitted())) throw new Error('This file is no longer available.');
        const grant = await client.downloadAttachment(id);
        controller.signal.throwIfAborted();
        await files.share(id, grant, controller.signal, permitted);
      } finally {
        clearTimeout(timeout);
        lifetime.signal.removeEventListener('abort', abort);
      }
    },
    dispose: () => {
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
