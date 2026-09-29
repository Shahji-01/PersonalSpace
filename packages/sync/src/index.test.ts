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
  const store: SyncStore = {
    pending: async () => queue,
    acknowledge: vi.fn(async () => {
      queue = [];
    }),
    reject: vi.fn(),
    cursor: async () => 0,
    merge: vi.fn(),
  };
  const transport: Transport = {
    push: vi.fn(async () => ({
      results: [{ mutationId: item.mutationId, status: 'applied' as const, records: [] }],
    })),
    pull: vi.fn(async () => ({ changes: [], nextCursor: 1, hasMore: false })),
  };
  return { store, transport, engine: createSyncEngine(store, transport) };
}
describe('durable sync coordination', () => {
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
    expect(store.merge).toHaveBeenCalledWith([], 1);
  });
});
