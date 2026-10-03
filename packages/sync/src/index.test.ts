import { describe, it, expect, vi } from 'vitest';
import { createSyncEngine, type SyncStore, type Transport } from './index';
import type { Mutation } from '@personalspace/validation';

const item: Mutation = {
  mutationId: '01900000-0000-7000-8000-000000000001',
  command: {
    op: 'capture',
    payload: {
      id: '01900000-0000-7000-8000-000000000002',
      type: 'inbox',
      text: 'A thought',
      plannedDate: null,
    },
  },
};
function setup() {
  let queue = [item];
  let cursor = 0;
  let recovering = false;
  const store: SyncStore = {
    pending: async () => queue,
    acknowledge: vi.fn(async () => {
      queue = [];
    }),
    reject: vi.fn(),
    cursor: async () => cursor,
    recovering: async () => recovering,
    beginRecovery: vi.fn(async () => {
      recovering = true;
      cursor = 0;
    }),
    finishRecovery: vi.fn(async () => {
      recovering = false;
    }),
    merge: vi.fn(async (_records, next) => {
      cursor = next;
    }),
  };
  const transport: Transport = {
    push: vi.fn(async () => ({
      results: [{ mutationId: item.mutationId, status: 'applied' as const, records: [] }],
    })),
    pull: vi.fn(async () => ({ changes: [], nextCursor: Math.max(cursor, 1), hasMore: false })),
  };
  return { store, transport, engine: createSyncEngine(store, transport) };
}
describe('durable sync coordination', () => {
  it('recovers an expired cursor before replaying the original queued mutation', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.pull)
      .mockRejectedValueOnce({ status: 410, code: 'RESYNC_REQUIRED' })
      .mockResolvedValueOnce({ changes: [], nextCursor: 2, hasMore: true })
      .mockResolvedValueOnce({ changes: [], nextCursor: 4, hasMore: false });
    await engine.sync();
    expect(store.beginRecovery).toHaveBeenCalledOnce();
    expect(transport.pull).toHaveBeenNthCalledWith(2, 0, true);
    expect(transport.pull).toHaveBeenNthCalledWith(3, 2, true);
    expect(store.finishRecovery).toHaveBeenCalledOnce();
    expect(vi.mocked(store.finishRecovery).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.push).mock.invocationCallOrder[0]!,
    );
    expect(transport.push).toHaveBeenCalledWith([item]);
  });
  it('resumes an interrupted recovery after restart without pushing early or losing its cursor', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.pull)
      .mockRejectedValueOnce({ status: 410, code: 'RESYNC_REQUIRED' })
      .mockResolvedValueOnce({ changes: [], nextCursor: 7, hasMore: true })
      .mockRejectedValueOnce(new Error('offline'));
    await expect(engine.sync()).rejects.toThrow('offline');
    expect(await store.recovering()).toBe(true);
    expect(await store.cursor()).toBe(7);
    expect(transport.push).not.toHaveBeenCalled();
    await createSyncEngine(store, transport).sync();
    expect(transport.pull).toHaveBeenNthCalledWith(4, 7, true);
    expect(await store.recovering()).toBe(false);
    expect(transport.push).toHaveBeenCalledWith([item]);
  });
  it('does not reinterpret unrelated failures as a reset or loop on malformed recovery pages', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.pull).mockRejectedValueOnce({ status: 401, code: 'UNAUTHORIZED' });
    await expect(engine.sync()).rejects.toMatchObject({ status: 401 });
    expect(store.beginRecovery).not.toHaveBeenCalled();
    vi.mocked(transport.pull)
      .mockRejectedValueOnce({ status: 410, code: 'RESYNC_REQUIRED' })
      .mockResolvedValueOnce({ changes: [], nextCursor: 0, hasMore: true });
    await expect(engine.sync()).rejects.toThrow('cursor did not advance');
    expect(store.finishRecovery).not.toHaveBeenCalled();
    expect(transport.push).not.toHaveBeenCalled();
  });
  it('passes deletion markers to the store before advancing to the next page', async () => {
    const { engine, store, transport } = setup();
    const tombstones = [
      {
        id: '01900000-0000-7000-8000-000000000002',
        version: 2,
        purgedAt: new Date().toISOString(),
      },
    ];
    vi.mocked(transport.pull)
      .mockResolvedValueOnce({ changes: [], tombstones, nextCursor: 2, hasMore: true })
      .mockResolvedValueOnce({ changes: [], nextCursor: 3, hasMore: false });
    await engine.sync();
    expect(store.merge).toHaveBeenNthCalledWith(1, [], 2, tombstones);
    expect(transport.pull).toHaveBeenNthCalledWith(2, 2, false);
  });
  it('preserves the original retry key when the response is lost', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.push).mockRejectedValueOnce(new Error('network disconnected'));
    await expect(engine.sync()).rejects.toThrow();
    expect(store.acknowledge).not.toHaveBeenCalled();
    await engine.sync();
    expect(transport.push).toHaveBeenNthCalledWith(2, [item]);
    expect(store.acknowledge).toHaveBeenCalledOnce();
  });
  it('coalesces overlapping reconnect and foreground triggers', async () => {
    const { engine, transport } = setup();
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(transport.push).toHaveBeenCalledOnce();
  });
  it('does not discard a missing server acknowledgement', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.push).mockResolvedValueOnce({ results: [] });
    await expect(engine.sync()).rejects.toThrow('Incomplete');
    expect(store.acknowledge).not.toHaveBeenCalled();
  });
  it('surfaces a conflict and continues pulling authoritative state', async () => {
    const { engine, store, transport } = setup();
    vi.mocked(transport.push).mockResolvedValueOnce({
      results: [
        {
          mutationId: item.mutationId,
          status: 'conflict',
          code: 'VERSION_CONFLICT',
          message: 'Refresh this task.',
        },
      ],
    });
    await engine.sync();
    expect(store.reject).toHaveBeenCalledWith(item.mutationId, 'Refresh this task.');
    expect(store.merge).toHaveBeenCalledWith([], 1, []);
  });
});
