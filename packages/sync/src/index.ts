import type { Mutation, MutationResult, RecordItem } from '@personalspace/validation';

export interface SyncStore {
  pending(): Promise<Mutation[]>;
  acknowledge(id: string, records: RecordItem[]): Promise<void>;
  reject(id: string, message: string): Promise<void>;
  cursor(): Promise<number>;
  merge(records: RecordItem[], cursor: number): Promise<void>;
}
export interface Transport {
  push(mutations: Mutation[]): Promise<{ results: MutationResult[] }>;
  pull(cursor: number): Promise<{ changes: RecordItem[]; nextCursor: number; hasMore: boolean }>;
}
export function createSyncEngine(store: SyncStore, transport: Transport) {
  let running: Promise<void> | null = null;
  async function run() {
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
    let cursor = await store.cursor();
    for (;;) {
      const page = await transport.pull(cursor);
      if (page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor))
        throw new Error('Sync cursor did not advance');
      await store.merge(page.changes, page.nextCursor);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
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
