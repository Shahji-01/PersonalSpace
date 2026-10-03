import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, createClient, createAttachmentTransport } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const file = {
  id: '019aaaaa-0000-7000-8000-000000000001',
  parentId: '019aaaaa-0000-7000-8000-000000000002',
  filename: 'file.txt',
  size: 1,
  mime: 'text/plain' as const,
  sha256: 'a'.repeat(64),
};
function attachmentSetup() {
  const grant = {
    url: 'https://objects.example.test/private?signature=test',
    method: 'PUT' as const,
    headers: { 'content-length': '1' },
    expiresAt: '2030-01-01T00:00:00Z',
  };
  const client = {
    openAttachment: vi.fn(async () => ({ status: 'ready' as const })),
    attachmentPart: vi.fn(async () => grant),
    completeAttachment: vi.fn(async () => ({ status: 'processing' as const })),
  };
  const put = vi.fn(async () => ({ status: 200, etag: 'part' as string | null }));
  const signal = new AbortController().signal;
  const part = {
    descriptor: file,
    sessionId: 'session',
    number: 1,
    localUri: 'file:///private/local',
    start: 0,
    end: 1,
    signal,
  };
  return { client, put, part, signal, grant, transport: createAttachmentTransport(client, put) };
}
it('maps API failures to durable transfer retry/auth/rejection policies', async () => {
  const { client, transport, signal } = attachmentSetup();
  for (const [status, code, expected] of [
    [401, 'UNAUTHENTICATED', 'auth'],
    [429, 'UPLOAD_RATE_LIMITED', 'retry'],
    [409, 'UPLOAD_SESSION_CHANGED', 'retry'],
    [404, 'NOTE_NOT_FOUND', 'retry'],
    [404, 'ATTACHMENT_NOT_FOUND', 'rejected'],
    [422, 'STORAGE_QUOTA_EXCEEDED', 'rejected'],
  ] as const) {
    client.openAttachment.mockRejectedValueOnce(
      new ApiError(status, code, 'Private server payload', 60000),
    );
    await expect(transport.open(file, null, signal)).rejects.toMatchObject({
      kind: expected,
      message: expected,
    });
  }
  client.openAttachment.mockRejectedValueOnce(
    new ApiError(429, 'UPLOAD_RATE_LIMITED', 'Rate limit'),
  );
  await expect(transport.open(file, null, signal)).rejects.toMatchObject({ retryAfterMs: 3600000 });
});
it('refreshes expired object grants without pausing the API session and forwards exact byte ranges', async () => {
  const { transport, client, put, part, grant } = attachmentSetup();
  put.mockResolvedValueOnce({ status: 403, etag: null });
  await expect(transport.putPart(part)).rejects.toMatchObject({ kind: 'retry' });
  expect(await transport.putPart(part)).toBe('part');
  expect(client.attachmentPart).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenLastCalledWith({
    localUri: part.localUri,
    start: 0,
    end: 1,
    grant,
    signal: part.signal,
  });
  put.mockResolvedValueOnce({ status: 400, etag: null });
  await expect(transport.putPart(part)).rejects.toMatchObject({ kind: 'local_file' });
});
it('refuses credential-bearing storage grants and missing part acknowledgements', async () => {
  const { transport, client, put, part, grant } = attachmentSetup();
  client.attachmentPart.mockResolvedValueOnce({
    ...grant,
    headers: { ...grant.headers, Authorization: 'private-token' },
  } as typeof grant);
  await expect(transport.putPart(part)).rejects.toMatchObject({ kind: 'protocol' });
  expect(put).not.toHaveBeenCalled();
  put.mockResolvedValueOnce({ status: 200, etag: null });
  await expect(transport.putPart(part)).rejects.toMatchObject({ kind: 'protocol' });
});
it('preserves HTTP errors and rate-limit delays even for non-JSON proxy responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Busy', { status: 429, headers: { 'Retry-After': '60' } })),
  );
  await expect(createClient('http://localhost', () => null).pull(0)).rejects.toMatchObject({
    status: 429,
    code: 'REQUEST_FAILED',
    retryAfterMs: 60000,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  await expect(createClient('http://localhost', () => null).pull(0)).rejects.toBeInstanceOf(
    ApiError,
  );
});
it('reads HTTP-date Retry-After and ignores malformed retry delays', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  const fetcher = vi.fn(
    async () =>
      new Response('{}', {
        status: 503,
        headers: { 'Retry-After': 'Fri, 02 Oct 2026 12:02:00 GMT' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = createClient('http://localhost', () => null);
  await expect(client.pull(0)).rejects.toMatchObject({ retryAfterMs: 120000 });
  fetcher.mockImplementation(
    async () => new Response('{}', { status: 503, headers: { 'Retry-After': 'invalid' } }),
  );
  await expect(client.pull(0)).rejects.toMatchObject({ retryAfterMs: undefined });
});
