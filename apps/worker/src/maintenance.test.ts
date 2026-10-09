import { beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@personalspace/db';
import {
  cleanupTrash,
  cleanupIdempotencyKeys,
  reconcileBalances,
  expireExports,
} from '@personalspace/domain';
import { runMaintenance } from './maintenance';

vi.mock('@personalspace/domain', () => ({
  cleanupTrash: vi.fn(),
  cleanupIdempotencyKeys: vi.fn(),
  reconcileBalances: vi.fn(),
  expireExports: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cleanupTrash).mockResolvedValue(3);
  vi.mocked(cleanupIdempotencyKeys).mockResolvedValue(2);
  vi.mocked(reconcileBalances).mockResolvedValue({
    drifts: [{ accountId: 'private-account', cached: 100, computed: 500 }],
  });
  vi.mocked(expireExports).mockResolvedValue(1);
});
it('reports aggregate counts without exposing financial values or account identifiers', async () => {
  const log = vi.fn();
  await runMaintenance({} as Database, log);
  expect(log.mock.calls).toEqual([
    ['trash_cleanup', { count: 3 }],
    ['idempotency_compaction', { count: 2 }],
    ['balance_drift_detected', { count: 1 }],
    ['export_expiry', { count: 1 }],
  ]);
});
it('continues independent jobs and fails the queue attempt with a generic retryable error', async () => {
  vi.mocked(cleanupTrash).mockRejectedValue(new Error('private database content'));
  const log = vi.fn();
  await expect(runMaintenance({} as Database, log)).rejects.toThrow(
    'Maintenance incomplete; retry required.',
  );
  expect(expireExports).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('trash_cleanup_failed');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private');
});
