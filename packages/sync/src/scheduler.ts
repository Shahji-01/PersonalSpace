export type SyncState =
  | { status: 'syncing' | 'synced' }
  | { status: 'retrying'; retryAt: number; error: unknown }
  | { status: 'paused'; error: unknown };

/** Schedules foreground sync without changing durable outbox/replay semantics. */
export function createSyncScheduler(options: {
  sync: () => Promise<void>;
  onState: (state: SyncState) => void;
  retry: (error: unknown) => { afterMs?: number; pause?: boolean };
  random?: () => number;
}) {
  let active = true;
  let disposed = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let retryAt = 0;
  let serverRetryAt = 0;
  let paused = false;
  let again = false;
  const random = options.random ?? Math.random;
  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule(at: number) {
    clearTimer();
    if (active && !disposed && !paused)
      timer = setTimeout(() => void request(), Math.min(2147483647, Math.max(0, at - Date.now())));
  }
  async function run() {
    do {
      again = false;
      options.onState({ status: 'syncing' });
      try {
        await options.sync();
      } catch (error) {
        if (disposed) return;
        const policy = options.retry(error);
        paused = !!policy.pause;
        if (paused) {
          options.onState({ status: 'paused', error });
        } else {
          // Equal jitter avoids bursts while keeping retry delays bounded (1s–5m).
          const ceiling = Math.min(300000, 2000 * 2 ** Math.min(failures++, 8));
          const delay = Math.round(ceiling * (0.5 + random() * 0.5));
          serverRetryAt = Date.now() + Math.max(0, policy.afterMs ?? 0);
          retryAt = Math.max(Date.now() + delay, serverRetryAt);
          options.onState({ status: 'retrying', retryAt, error });
          schedule(retryAt);
        }
        return;
      }
      if (disposed) return;
      failures = 0;
      retryAt = serverRetryAt = 0;
      options.onState({ status: 'synced' });
      // A mutation can arrive after the engine has read its initial outbox.
      // Drain once more on success; failures must still respect the retry delay.
    } while (again && active);
    schedule(Date.now() + 30000);
  }
  function request(manual = false): Promise<void> {
    if (disposed || !active) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    if (paused && !manual) return Promise.resolve();
    if (manual) paused = false;
    const allowedAt = manual ? serverRetryAt : retryAt;
    if (allowedAt > Date.now()) {
      schedule(allowedAt);
      return Promise.resolve();
    }
    clearTimer();
    running = run().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    request,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      clearTimer();
      if (active) void request();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
