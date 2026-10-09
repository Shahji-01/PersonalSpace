import type { Queue } from 'bullmq';

export async function scheduleAccountDeletion(queue: Pick<Queue, 'add'>) {
  // Keep the existing repeat identity so restarts/upgrades do not duplicate it.
  // BullMQ deduplicates repeat definitions; unrelated schedules cannot suppress it.
  await queue.add(
    'process-deletions',
    {},
    {
      repeat: { pattern: '0 * * * *' },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 7 * 86400 },
      removeOnFail: false,
    },
  );
}
