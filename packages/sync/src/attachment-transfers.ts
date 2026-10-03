import {
  attachmentLimits,
  attachmentTransferSchema,
  attachmentUploadStateSchema,
  uploadedPartSchema,
  type AttachmentDescriptor,
  type AttachmentTransfer,
  type AttachmentUploadState,
  type UploadedPart,
} from '@personalspace/validation';

export interface AttachmentTransferStore {
  list(): Promise<AttachmentTransfer[]>;
  get(id: string): Promise<AttachmentTransfer | null>;
  // Must be atomic and must never insert a missing row. Deletion wins over in-flight work.
  replace(expectedRevision: number, transfer: AttachmentTransfer): Promise<boolean>;
}

export interface AttachmentUploadTransport {
  // Idempotent by descriptor.id; checks ownership and resumes/reconciles an existing upload.
  open(
    descriptor: AttachmentDescriptor,
    sessionId: string | null,
    signal: AbortSignal,
  ): Promise<AttachmentUploadState>;
  // Obtain a fresh short-lived URL inside this adapter, then PUT the byte range without
  // attaching the API bearer token. Never persist signed URLs in the queue.
  putPart(input: {
    descriptor: AttachmentDescriptor;
    sessionId: string;
    number: number;
    localUri: string;
    start: number;
    end: number; // Exclusive, matching Blob.slice.
    signal: AbortSignal;
  }): Promise<string>;
  // Must be idempotent; a lost response is reconciled by open() on the next drain.
  complete(
    id: string,
    sessionId: string,
    parts: UploadedPart[],
    signal: AbortSignal,
  ): Promise<Exclude<AttachmentUploadState, { status: 'uploading' }>>;
}

export class AttachmentTransferError extends Error {
  constructor(
    public readonly kind: 'retry' | 'auth' | 'rejected' | 'local_file' | 'protocol',
    public readonly retryAfterMs = 0,
  ) {
    // Error payloads from object storage can contain signed URLs. Persist only these codes.
    super(kind);
  }
}

export function newAttachmentTransfer(
  descriptor: AttachmentDescriptor,
  localUri: string,
  now = Date.now(),
): AttachmentTransfer {
  return attachmentTransferSchema.parse({
    descriptor,
    localUri,
    revision: 0,
    state: 'queued',
    session: null,
    parts: [],
    failures: 0,
    nextAttemptAt: 0,
    error: null,
    createdAt: now,
  });
}

export type AttachmentDrainResult = {
  nextAttemptAt: number | null;
  waitingForNetwork: boolean;
  waitingForWifi: boolean;
  authenticationRequired: boolean;
};

/** One foreground consumer per account, independent of the row-sync engine.
 * The host requests another drain on connectivity/foreground changes or nextAttemptAt.
 * Backoff and multipart progress survive process death because they live in the store.
 */
export function createAttachmentTransferEngine(options: {
  store: AttachmentTransferStore;
  transport: AttachmentUploadTransport;
  inspect: (uri: string, signal: AbortSignal) => Promise<{ size: number; sha256: string }>;
  network: () => { connected: boolean; wifi: boolean };
  wifiOnlyForLargeFiles?: () => boolean;
  now?: () => number;
  random?: () => number;
  requestTimeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const timeoutMs = options.requestTimeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new Error('Invalid attachment request timeout');
  const lifetime = new AbortController();
  let running: Promise<AttachmentDrainResult> | null = null;

  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (lifetime.signal.aborted) throw new Error('Transfer engine disposed');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    lifetime.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, timeoutMs);
    // Race as well as abort: a platform adapter must not stall every later queued file
    // if it fails to observe its AbortSignal. No late result is allowed to update state.
    let removeAbortListener = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new AttachmentTransferError('retry'));
      controller.signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', abort);
    });
    try {
      return await Promise.race([run(controller.signal), cancelled]);
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
      lifetime.signal.removeEventListener('abort', cancel);
    }
  }

  async function drain(): Promise<AttachmentDrainResult> {
    const result: AttachmentDrainResult = {
      nextAttemptAt: null,
      waitingForNetwork: false,
      waitingForWifi: false,
      authenticationRequired: false,
    };
    const due = (at: number) => {
      result.nextAttemptAt = Math.min(result.nextAttemptAt ?? at, at);
    };
    const permitted = (job: AttachmentTransfer) => {
      if (lifetime.signal.aborted) return false;
      const network = options.network();
      if (!network.connected) {
        result.waitingForNetwork = true;
        return false;
      }
      if (
        job.descriptor.size > attachmentLimits.wifiOnlyAboveBytes &&
        (options.wifiOnlyForLargeFiles?.() ?? true) &&
        !network.wifi
      ) {
        result.waitingForWifi = true;
        return false;
      }
      return true;
    };
    for (const candidate of await options.store.list()) {
      if (lifetime.signal.aborted) break;
      let job = await options.store.get(candidate.descriptor.id);
      if (!job || job.state === 'ready' || job.state === 'failed') continue;
      if (job.state === 'auth_required') {
        result.authenticationRequired = true;
        break;
      }
      if (job.nextAttemptAt > now()) {
        due(job.nextAttemptAt);
        continue;
      }
      if (!permitted(job)) continue;
      const update = async (patch: Partial<AttachmentTransfer>) => {
        if (lifetime.signal.aborted || !job) return false;
        const next = attachmentTransferSchema.parse({ ...job, ...patch, revision: job.revision + 1 });
        if (!(await options.store.replace(job.revision, next))) return false;
        job = next;
        return true;
      };
      const current = async () =>
        !lifetime.signal.aborted &&
        (await options.store.get(candidate.descriptor.id))?.revision === job?.revision;
      try {
        const descriptor = job.descriptor;
        const remote = attachmentUploadStateSchema.safeParse(
          await request((signal) => options.transport.open(descriptor, job!.session?.id ?? null, signal)),
        );
        if (!remote.success) throw new AttachmentTransferError('protocol');
        if (!(await current())) continue;
        if (remote.data.status !== 'uploading') {
          const status = remote.data.status;
          const nextAttemptAt = status === 'processing' ? now() + 30000 : 0;
          if (await update({ state: status === 'rejected' ? 'failed' : status, error: status === 'rejected' ? 'rejected' : null, failures: 0, nextAttemptAt }))
            if (nextAttemptAt) due(nextAttemptAt);
          continue;
        }
        const { session, parts } = remote.data;
        const count = Math.ceil(descriptor.size / session.partSize);
        if (
          (descriptor.size > attachmentLimits.multipartAboveBytes && session.partSize !== attachmentLimits.multipartAboveBytes) ||
          new Set(parts.map((part) => part.number)).size !== parts.length ||
          parts.some((part) => part.number > count)
        ) throw new AttachmentTransferError('protocol');
        if (!(await update({ session, parts, state: 'uploading', error: null }))) continue;
        if (parts.length < count) {
          const fingerprint = await request((signal) => options.inspect(job!.localUri, signal));
          if (fingerprint.size !== descriptor.size || fingerprint.sha256 !== descriptor.sha256)
            throw new AttachmentTransferError('local_file');
        }
        for (let number = 1; number <= count; number++) {
          if (job.parts.some((part) => part.number === number)) continue;
          if (!(await current()) || !permitted(job)) break;
          const etag = await request((signal) => options.transport.putPart({
            descriptor,
            sessionId: session.id,
            number,
            localUri: job!.localUri,
            start: (number - 1) * session.partSize,
            end: Math.min(descriptor.size, number * session.partSize),
            signal,
          }));
          const part = uploadedPartSchema.safeParse({ number, etag });
          if (!part.success) throw new AttachmentTransferError('protocol');
          if (!(await update({ parts: [...job.parts, part.data].sort((a, b) => a.number - b.number) }))) break;
        }
        if (!(await current()) || !permitted(job) || job.parts.length !== count) continue;
        const completed = attachmentUploadStateSchema.safeParse(
          await request((signal) => options.transport.complete(descriptor.id, session.id, job!.parts, signal)),
        );
        if (!completed.success || completed.data.status === 'uploading')
          throw new AttachmentTransferError('protocol');
        const status = completed.data.status;
        const nextAttemptAt = status === 'processing' ? now() + 30000 : 0;
        if (await update({ state: status === 'rejected' ? 'failed' : status, error: status === 'rejected' ? 'rejected' : null, failures: 0, nextAttemptAt }))
          if (nextAttemptAt) due(nextAttemptAt);
      } catch (error) {
        if (lifetime.signal.aborted) break;
        const failure = error instanceof AttachmentTransferError ? error : new AttachmentTransferError('retry');
        const ceiling = Math.min(300000, 2000 * 2 ** Math.min(job.failures, 8));
        const retryAfter = Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs) : 0;
        const nextAttemptAt = failure.kind === 'retry'
          ? Math.min(Number.MAX_SAFE_INTEGER, now() + Math.max(Math.round(ceiling * (0.5 + random() * 0.5)), retryAfter))
          : 0;
        if (!(await update({
          state: failure.kind === 'retry' ? job.state : failure.kind === 'auth' ? 'auth_required' : 'failed',
          failures: Math.min(job.failures + 1, 1000),
          error: failure.kind,
          nextAttemptAt,
        }))) continue;
        if (failure.kind === 'auth') {
          result.authenticationRequired = true;
          break;
        }
        if (nextAttemptAt) due(nextAttemptAt);
      }
    }
    return result;
  }
  return {
    drain() {
      running ??= drain().finally(() => { running = null; });
      return running;
    },
    dispose() { lifetime.abort(); },
  };
}
