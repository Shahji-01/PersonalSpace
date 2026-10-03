import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
