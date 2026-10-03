import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncScheduler } from './scheduler';

afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  const sync = vi.fn(async () => {});
  const onState = vi.fn();
  const retry = vi.fn((_error: unknown): { pause?: boolean; afterMs?: number } => ({}));
  return {
    sync,
    onState,
    retry,
    scheduler: createSyncScheduler({ sync, onState, retry, random: () => 1 }),
  };
}
describe('foreground sync scheduling', () => {
  it('backs off exponentially, caps at five minutes, and resets after recovery', async () => {
    const { scheduler, sync, onState } = setup();
    sync.mockRejectedValue(new Error('offline'));
    await scheduler.request();
    for (const delay of [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]) {
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'retrying', retryAt: Date.now() + delay }),
      );
      await vi.advanceTimersByTimeAsync(delay);
    }
    sync.mockResolvedValue(undefined);
    await scheduler.request(true);
    expect(onState).toHaveBeenLastCalledWith({ status: 'synced' });
    sync.mockRejectedValue(new Error('offline again'));
    await scheduler.request();
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryAt: Date.now() + 2000 }),
    );
    scheduler.dispose();
  });
  it('respects server Retry-After even on manual refresh and foreground changes', async () => {
    const { scheduler, sync, retry } = setup();
    retry.mockReturnValue({ afterMs: 60000 });
    sync.mockRejectedValueOnce(new Error('rate limited'));
    await scheduler.request();
    scheduler.setActive(false);
    await vi.advanceTimersByTimeAsync(10000);
    scheduler.setActive(true);
    await scheduler.request(true);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('pauses after an auth failure until an explicit retry', async () => {
    const { scheduler, sync, retry, onState } = setup();
    retry.mockReturnValue({ pause: true });
    sync.mockRejectedValueOnce(new Error('expired session'));
    await scheduler.request();
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused' }));
    await vi.advanceTimersByTimeAsync(600000);
    scheduler.setActive(false);
    scheduler.setActive(true);
    await scheduler.request();
    expect(sync).toHaveBeenCalledTimes(1);
    await scheduler.request(true);
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('drains edits requested during an in-flight sync without overlapping requests', async () => {
    const { scheduler, sync } = setup();
    let finish!: () => void;
    sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const initial = scheduler.request();
    const second = scheduler.request();
    const third = scheduler.request();
    expect(sync).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([initial, second, third]);
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('keeps failed in-flight edits on the backoff schedule and stops work after disposal', async () => {
    const { scheduler, sync, onState } = setup();
    let fail!: (error: Error) => void;
    sync.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const initial = scheduler.request();
    void scheduler.request();
    fail(new Error('offline'));
    await initial;
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.setActive(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.setActive(true);
    await scheduler.request();
    scheduler.dispose();
    const calls = sync.mock.calls.length;
    const notifications = onState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    await scheduler.request(true);
    expect(sync).toHaveBeenCalledTimes(calls);
    expect(onState).toHaveBeenCalledTimes(notifications);
  });
});
