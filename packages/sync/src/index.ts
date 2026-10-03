import type { Mutation, MutationResult, RecordItem, Tombstone } from '@personalspace/validation';
export { createSyncScheduler, type SyncState } from './scheduler';
export {
  createAttachmentTransferEngine,
  newAttachmentTransfer,
  AttachmentTransferError,
  type AttachmentTransferStore,
  type AttachmentUploadTransport,
  type AttachmentDrainResult,
} from './attachment-transfers';

export interface SyncStore {
  pending(): Promise<Mutation[]>;
  acknowledge(id: string, records: RecordItem[]): Promise<void>;
  reject(id: string, message: string): Promise<void>;
  cursor(): Promise<number>;
  recovering(): Promise<boolean>;
  beginRecovery(): Promise<void>;
  finishRecovery(): Promise<void>;
  merge(records: RecordItem[], cursor: number, tombstones?: Tombstone[]): Promise<void>;
}
export interface Transport {
  push(mutations: Mutation[]): Promise<{ results: MutationResult[] }>;
  pull(
    cursor: number,
    full?: boolean,
  ): Promise<{
    changes: RecordItem[];
    tombstones?: Tombstone[];
    nextCursor: number;
    hasMore: boolean;
  }>;
}
export function createSyncEngine(store: SyncStore, transport: Transport) {
  let running: Promise<void> | null = null;
  async function pullAll() {
    let cursor = await store.cursor();
    let full = await store.recovering();
    let restarted = false;
    for (;;) {
      let page: Awaited<ReturnType<Transport['pull']>>;
      try {
        page = await transport.pull(cursor, full);
      } catch (error) {
        if (
          !restarted &&
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 410 &&
          'code' in error &&
          error.code === 'RESYNC_REQUIRED'
        ) {
          await store.beginRecovery();
          cursor = 0;
          full = restarted = true;
          continue;
        }
        throw error;
      }
      if (page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor))
        throw new Error('Sync cursor did not advance');
      await store.merge(page.changes, page.nextCursor, page.tombstones ?? []);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        if (full) await store.finishRecovery();
        break;
      }
    }
  }
  async function run() {
    // Check retention/recover first so old queued edits cannot run ahead of
    // deletion markers. Resume interrupted recovery before replaying anything.
    await pullAll();
    const queued = await store.pending();
    for (let start = 0; start < queued.length; start += 50) {
      const batch = queued.slice(start, start + 50);
      const { results } = await transport.push(batch);
      // Do not clear an outbox item without an explicit, matching server result.
      const requested = new Set(batch.map((m) => m.mutationId));
      for (const result of results) {
        if (!requested.has(result.mutationId)) throw new Error('Unexpected sync acknowledgement');
        requested.delete(result.mutationId);
        if (result.status === 'applied') await store.acknowledge(result.mutationId, result.records);
        else await store.reject(result.mutationId, result.message);
      }
      if (requested.size) throw new Error('Incomplete sync acknowledgement');
    }
    if (queued.length) await pullAll();
  }
  return {
    sync: () => {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
