import { expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import {
  backgroundSchedules,
  ensureBackgroundSchedule,
  reconcileBackgroundSchedules,
  runBackgroundSchedules,
} from './background-schedules';

function fixture() {
  return {
    add: vi.fn<Queue['add']>().mockResolvedValue(undefined as never),
    getRepeatableJobs: vi.fn<Queue['getRepeatableJobs']>().mockResolvedValue([]),
  };
}

it('does not let unrelated repeat definitions suppress the required schedule', async () => {
  const queue = fixture();
  queue.getRepeatableJobs.mockResolvedValue([
    {
      key: 'unrelated',
      name: 'fetch-metadata',
      id: 'other',
      pattern: '*/5 * * * *',
      next: 1,
      endDate: null,
      tz: null,
    },
  ]);
  await ensureBackgroundSchedule(queue, backgroundSchedules[2]);
  expect(queue.add).toHaveBeenCalledWith(
    'fetch-metadata',
    {},
    expect.objectContaining({
      repeat: { pattern: '*/5 * * * *' },
    }),
  );
});

it('preserves an existing delayed occurrence instead of advancing its repeat definition', async () => {
  const queue = fixture();
  queue.getRepeatableJobs.mockResolvedValue([
    { key: 'legacy', name: 'nightly', pattern: '0 2 * * *', next: 1, endDate: null, tz: null },
  ]);
  await ensureBackgroundSchedule(queue, backgroundSchedules[1]);
  expect(queue.add).not.toHaveBeenCalled();
});

it('attempts every independent schedule even while one lookup is stalled, and recovers failure', async () => {
  const queues = new Map(backgroundSchedules.map((schedule) => [schedule.queue, fixture()]));
  const deletion = queues.get('deletion')!;
  let rejectLookup!: (error: Error) => void;
  deletion.getRepeatableJobs.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectLookup = reject;
      }),
  );
  const log = vi.fn();
  const firstPass = reconcileBackgroundSchedules(queues, log);
  await vi.waitFor(() => expect(queues.get('email')!.add).toHaveBeenCalledOnce());
  rejectLookup(new Error('private Redis connection details'));
  await firstPass;
  expect(log.mock.calls).toEqual([['deletion_schedule_failed']]);
  await reconcileBackgroundSchedules(queues, log);
  expect(deletion.add).toHaveBeenCalledWith(
    'process-deletions',
    {},
    expect.objectContaining({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }),
  );
  expect(queues.get('maintenance')!.add).toHaveBeenCalledWith(
    'nightly',
    {},
    expect.objectContaining({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }),
  );
});

it('does not connect or schedule work after shutdown', async () => {
  const stop = new AbortController();
  stop.abort();
  const log = vi.fn();
  await runBackgroundSchedules('not a Redis URL', stop.signal, log);
  expect(log).not.toHaveBeenCalled();
});
