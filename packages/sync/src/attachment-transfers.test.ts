import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentLimits, type AttachmentUploadState } from '@personalspace/validation';
import {
  AttachmentTransferError,
  createAttachmentTransferEngine,
  newAttachmentTransfer,
  type AttachmentTransferStore,
  type AttachmentUploadTransport,
} from './attachment-transfers';

const MB = 1024 * 1024;
let sequence = 0;
function transfer(size = 12 * MB) {
  return newAttachmentTransfer(
    {
      id: `019aaaaa-0000-7000-8000-${(++sequence).toString().padStart(12, '0')}`,
      parentId: '019aaaaa-0000-7000-8000-000000000000',
      filename: 'private photo.jpg',
      size,
      mime: 'image/jpeg',
      sha256: 'a'.repeat(64),
    },
    'file:///documents/account/attachment',
    100,
  );
}
function setup(jobs = [transfer()]) {
  const rows = new Map(jobs.map((job) => [job.descriptor.id, structuredClone(job)]));
  const store: AttachmentTransferStore = {
    list: async () => structuredClone([...rows.values()]),
    get: async (id) => structuredClone(rows.get(id) ?? null),
    replace: async (revision, job) => {
      if (rows.get(job.descriptor.id)?.revision !== revision) return false;
      rows.set(job.descriptor.id, structuredClone(job));
      return true;
    },
  };
  let clock = 1000;
  let connected = true;
  let wifi = true;
  let wifiOnly = true;
  const remoteParts = new Map<string, { number: number; etag: string }[]>();
  const open = vi.fn<AttachmentUploadTransport['open']>(async (descriptor) => ({
    status: 'uploading',
    session: { id: descriptor.id, partSize: 5 * MB },
    parts: structuredClone(remoteParts.get(descriptor.id) ?? []),
  }));
  const putPart = vi.fn<AttachmentUploadTransport['putPart']>(async ({ descriptor, number }) => {
    const etag = `"part-${number}"`;
    const parts = remoteParts.get(descriptor.id) ?? [];
    remoteParts.set(descriptor.id, [...parts.filter((p) => p.number !== number), { number, etag }]);
    return etag;
  });
  const complete = vi.fn<AttachmentUploadTransport['complete']>(async () => ({ status: 'ready' }));
  const inspect = vi.fn(async () => ({ size: jobs[0]!.descriptor.size, sha256: 'a'.repeat(64) }));
  const options = {
    store,
    transport: { open, putPart, complete },
    inspect,
    now: () => clock,
    random: () => 1,
    network: () => ({ connected, wifi }),
    wifiOnlyForLargeFiles: () => wifiOnly,
  };
  return {
    ...options,
    open,
    putPart,
    complete,
    rows,
    remoteParts,
    engine: createAttachmentTransferEngine(options),
    restart: () => createAttachmentTransferEngine(options),
    advance: (ms: number) => {
      clock += ms;
    },
    setNetwork: (online: boolean, wireless = false) => {
      connected = online;
      wifi = wireless;
    },
    allowCellular: () => {
      wifiOnly = false;
    },
    get: (index = 0) => rows.get(jobs[index]!.descriptor.id)!,
  };
}
afterEach(() => vi.useRealTimers());

describe('durable attachment transfer engine', () => {
  it('uploads exact part ranges, checkpoints each ETag and polls processing without resending bytes', async () => {
    const s = setup();
    s.complete.mockResolvedValueOnce({ status: 'processing' });
    const result = await s.engine.drain();
    expect(s.putPart.mock.calls.map(([p]) => [p.number, p.start, p.end])).toEqual([
      [1, 0, 5 * MB],
      [2, 5 * MB, 10 * MB],
      [3, 10 * MB, 12 * MB],
    ]);
    expect(s.get().parts).toHaveLength(3);
    expect(s.get().state).toBe('processing');
    expect(result.nextAttemptAt).toBe(31000);
    await s.engine.drain();
    expect(s.open).toHaveBeenCalledTimes(1);
    s.advance(30000);
    s.open.mockResolvedValue({ status: 'ready' });
    await s.engine.drain();
    expect(s.get().state).toBe('ready');
    expect(s.putPart).toHaveBeenCalledTimes(3);
    expect(s.complete).toHaveBeenCalledWith(
      s.get().descriptor.id,
      s.get().session!.id,
      s.get().parts,
      expect.any(AbortSignal),
    );
  });

  it('survives a lost part response and restart, reconciling server parts before retrying', async () => {
    const s = setup();
    const upload = s.putPart.getMockImplementation()!;
    s.putPart.mockImplementation(async (part) => {
      const etag = await upload(part);
      if (part.number === 2) throw new Error('response lost, sensitive URL must not be saved');
      return etag;
    });
    await s.engine.drain();
    expect(s.get().parts.map((p) => p.number)).toEqual([1]);
    expect(s.get().nextAttemptAt).toBe(3000);
    expect(s.get().error).toBe('retry');
    expect(JSON.stringify(s.get())).not.toContain('sensitive');
    s.engine.dispose();
    const resumed = s.restart();
    await resumed.drain();
    expect(s.open).toHaveBeenCalledTimes(1);
    s.advance(2000);
    s.putPart.mockImplementation(upload);
    await resumed.drain();
    expect(s.putPart.mock.calls.map(([p]) => p.number)).toEqual([1, 2, 3]);
    expect(s.get().state).toBe('ready');
    expect(s.get().failures).toBe(0);
  });

  it('replaces stale progress when the server replaces an expired multipart session', async () => {
    const s = setup();
    s.putPart.mockRejectedValueOnce(new Error('offline'));
    await s.engine.drain();
    const previous = s.get();
    s.rows.set(previous.descriptor.id, { ...previous, parts: [{ number: 1, etag: 'old' }] });
    s.open.mockResolvedValue({
      status: 'uploading',
      session: { id: 'replacement', partSize: 5 * MB },
      parts: [],
    });
    s.advance(2000);
    await s.restart().drain();
    expect(s.putPart.mock.calls.slice(1).map(([p]) => [p.sessionId, p.number])).toEqual([
      ['replacement', 1],
      ['replacement', 2],
      ['replacement', 3],
    ]);
    expect(s.get().state).toBe('ready');
  });

  it('skips large files on cellular without blocking smaller queued files and handles offline mode', async () => {
    const large = transfer(),
      small = transfer(5 * MB);
    const s = setup([large, small]);
    s.inspect.mockResolvedValue({ size: small.descriptor.size, sha256: small.descriptor.sha256 });
    s.setNetwork(false);
    expect((await s.engine.drain()).waitingForNetwork).toBe(true);
    expect(s.open).not.toHaveBeenCalled();
    s.setNetwork(true);
    expect((await s.engine.drain()).waitingForWifi).toBe(true);
    expect(s.get(0).state).toBe('queued');
    expect(s.get(1).state).toBe('ready');
    s.allowCellular();
    s.inspect.mockResolvedValue({ size: large.descriptor.size, sha256: large.descriptor.sha256 });
    await s.engine.drain();
    expect(s.get().state).toBe('ready');
  });

  it('checks Wi-Fi again between parts and resumes without retransmitting completed parts', async () => {
    const s = setup();
    const upload = s.putPart.getMockImplementation()!;
    s.putPart.mockImplementation(async (part) => {
      const etag = await upload(part);
      s.setNetwork(true, false);
      return etag;
    });
    expect((await s.engine.drain()).waitingForWifi).toBe(true);
    expect(s.get().parts).toHaveLength(1);
    expect(s.complete).not.toHaveBeenCalled();
    s.setNetwork(true, true);
    s.putPart.mockImplementation(upload);
    await s.engine.drain();
    expect(s.putPart.mock.calls.map(([p]) => p.number)).toEqual([1, 2, 3]);
  });

  it('honors Retry-After across restarts and caps exponential retry delays at five minutes', async () => {
    const s = setup();
    s.open.mockRejectedValue(new AttachmentTransferError('retry', 600000));
    expect((await s.engine.drain()).nextAttemptAt).toBe(601000);
    s.advance(599999);
    await s.restart().drain();
    expect(s.open).toHaveBeenCalledTimes(1);
    s.advance(1);
    s.open.mockRejectedValue(new Error('network'));
    let expected = 601000;
    for (const delay of [4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
      expected += delay;
      expect((await s.engine.drain()).nextAttemptAt).toBe(expected);
      s.advance(delay);
    }
  });

  it('continues after one file fails but persists an auth pause for the whole account', async () => {
    const s = setup([transfer(1), transfer(1)]);
    s.open.mockRejectedValueOnce(new Error('network'));
    await s.engine.drain();
    expect(s.get().error).toBe('retry');
    expect(s.get(1).state).toBe('ready');
    s.advance(2000);
    s.open.mockRejectedValueOnce(new AttachmentTransferError('auth'));
    expect((await s.engine.drain()).authenticationRequired).toBe(true);
    expect(s.get().state).toBe('auth_required');
    s.open.mockClear();
    expect((await s.restart().drain()).authenticationRequired).toBe(true);
    expect(s.open).not.toHaveBeenCalled();
  });

  it('rejects a changed local file before PUT and accepts already-ready server copies without local bytes', async () => {
    const s = setup();
    s.inspect.mockResolvedValue({ size: 12 * MB, sha256: 'b'.repeat(64) });
    await s.engine.drain();
    expect(s.get()).toMatchObject({ state: 'failed', error: 'local_file' });
    expect(s.putPart).not.toHaveBeenCalled();
    const dedup = setup();
    dedup.open.mockResolvedValue({ status: 'ready' });
    await dedup.engine.drain();
    expect(dedup.inspect).not.toHaveBeenCalled();
    expect(dedup.get().state).toBe('ready');
  });

  it.each([
    [
      { number: 1, etag: 'a' },
      { number: 1, etag: 'b' },
    ],
    [{ number: 4, etag: 'out-of-range' }],
  ])(
    'rejects invalid remote progress instead of completing with missing bytes (%j)',
    async (...parts) => {
      const s = setup();
      s.open.mockResolvedValue({
        status: 'uploading',
        session: { id: 's', partSize: 5 * MB },
        parts,
      });
      await s.engine.drain();
      expect(s.get()).toMatchObject({ state: 'failed', error: 'protocol' });
      expect(s.putPart).not.toHaveBeenCalled();
      expect(s.complete).not.toHaveBeenCalled();
    },
  );

  it('coalesces overlapping drains and never resurrects a cancelled upload after a late response', async () => {
    const s = setup();
    let finish!: (state: AttachmentUploadState) => void;
    s.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = s.engine.drain(),
      second = s.engine.drain();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(s.open).toHaveBeenCalledTimes(1));
    s.rows.delete(s.get().descriptor.id);
    finish({ status: 'ready' });
    await first;
    expect(s.rows.size).toBe(0);
    expect(s.inspect).not.toHaveBeenCalled();
  });

  it('aborts on account disposal without persisting a late response or retry error', async () => {
    const s = setup();
    let finish!: (state: AttachmentUploadState) => void;
    let signal!: AbortSignal;
    s.open.mockImplementationOnce((_descriptor, _session, received) => {
      signal = received;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = s.engine.drain();
    await vi.waitFor(() => expect(s.open).toHaveBeenCalledTimes(1));
    s.engine.dispose();
    await pending;
    expect(signal.aborted).toBe(true);
    finish({ status: 'ready' });
    await Promise.resolve();
    expect(s.get()).toMatchObject({ state: 'queued', revision: 0, error: null });
    await s.engine.drain();
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it('drains a file enqueued during a running request without losing its wake-up', async () => {
    const s = setup([transfer(1)]);
    let finish!: (state: AttachmentUploadState) => void;
    s.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = s.engine.drain();
    await vi.waitFor(() => expect(s.open).toHaveBeenCalledTimes(1));
    const added = transfer(1);
    s.rows.set(added.descriptor.id, added);
    const next = s.engine.drain();
    finish({ status: 'ready' });
    await Promise.all([pending, next]);
    expect(s.rows.get(added.descriptor.id)!.state).toBe('ready');
    expect(s.open).toHaveBeenCalledTimes(2);
  });

  it('times out an unresponsive adapter and schedules a durable retry', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.open.mockImplementationOnce(() => new Promise(() => {}));
    const pending = s.engine.drain();
    await vi.advanceTimersByTimeAsync(60000);
    await pending;
    expect(s.get()).toMatchObject({ error: 'retry', failures: 1, nextAttemptAt: 3000 });
  });

  it('validates the size, hash and filename before accepting a transfer', () => {
    const sample = transfer(attachmentLimits.maxBytes);
    expect(() =>
      newAttachmentTransfer(
        { ...sample.descriptor, size: attachmentLimits.maxBytes + 1 },
        sample.localUri,
      ),
    ).toThrow();
    expect(() =>
      newAttachmentTransfer({ ...sample.descriptor, filename: '../secret' }, sample.localUri),
    ).toThrow();
    expect(() =>
      newAttachmentTransfer({ ...sample.descriptor, sha256: 'not-a-hash' }, sample.localUri),
    ).toThrow();
  });
});
