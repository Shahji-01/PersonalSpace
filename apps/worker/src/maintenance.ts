import type { Database } from '@personalspace/db';
import {
  cleanupTrash,
  cleanupIdempotencyKeys,
  reconcileBalances,
  expireExports,
} from '@personalspace/domain';
import type { Queue } from 'bullmq';

export async function scheduleMaintenance(queue: Pick<Queue, 'add'>) {
  // Preserve the legacy repeat identity so upgrades and concurrent starts deduplicate.
  await queue.add(
    'nightly',
    {},
    {
      repeat: { pattern: '0 2 * * *' },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 7 * 86400 },
      removeOnFail: false,
    },
  );
}

export async function runMaintenance(
  db: Database,
  log: (event: string, detail?: { count: number }) => void,
) {
  let failed = false;
  const jobs = [
    ['trash_cleanup', () => cleanupTrash(db)],
    ['idempotency_compaction', () => cleanupIdempotencyKeys(db)],
    ['balance_drift_detected', async () => (await reconcileBalances(db)).drifts.length],
    ['export_expiry', () => expireExports(db)],
  ] as const;
  for (const [event, run] of jobs) {
    try {
      log(event, { count: await run() });
    } catch {
      // Database/provider failures can contain private values. Persist a generic job error.
      log(`${event}_failed`);
      failed = true;
    }
  }
  if (failed) throw new Error('Maintenance incomplete; retry required.');
}
