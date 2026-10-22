import { afterEach, expect, it, vi } from 'vitest';
import {
  ConsoleEmailProvider,
  createEmailProvider,
  EmailDeliveryError,
  ResendEmailProvider,
  UnavailableEmailProvider,
  type EmailEnvelope,
} from './email-provider';

const message: EmailEnvelope = {
  idempotencyKey: 'personalspace/email/fixture-id',
  to: 'private@example.test',
  from: 'original@example.test',
  subject: 'Private subject',
  text: 'Secret reset token',
  html: '<p>Secret reset token</p>',
};
const receipt = '778c0c25-cbc8-4d11-bb67-6b0920370518';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('submits the immutable envelope and stable key with a timeout and preserves the receipt', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: receipt }));
  vi.stubGlobal('fetch', fetchMock);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const provider = new ResendEmailProvider('fixture-key', 'changed-config@example.test');
  expect(await provider.sendEmail(message)).toEqual({ kind: 'accepted', providerId: receipt });
  expect(timeout).toHaveBeenCalledWith(10_000);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.resend.com/emails');
  expect(options.redirect).toBe('error');
  expect(options.headers['Idempotency-Key']).toBe(message.idempotencyKey);
  expect(JSON.parse(options.body)).toEqual({
    from: message.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
});

it.each([
  [429, 'rate_limit_exceeded', 'provider_rate_limited', true],
  [503, 'application_error', 'provider_unavailable', true],
  [408, 'request_timeout', 'provider_unavailable', true],
  [422, 'validation_error', 'provider_rejected', false],
  [401, 'restricted_api_key', 'provider_rejected', false],
  [409, 'concurrent_idempotent_requests', 'provider_unavailable', true],
  [409, 'invalid_idempotent_request', 'provider_rejected', false],
] as const)(
  'normalizes HTTP %s (%s) without exposing response content',
  async (status, name, code, retryable) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { name, message: `${message.to} ${message.text}` },
            { status, headers: { 'Retry-After': '120' } },
          ),
        ),
    );
    const error = await new ResendEmailProvider('fixture-key', 'sender@example.test')
      .sendEmail(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error).toMatchObject({ code, retryable, retryAfterMs: 120_000 });
    expect(String(error)).not.toContain(message.to);
    expect(String(error)).not.toContain(message.text);
  },
);

it('aborts a timed-out request and exposes only a retryable category', async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(new Error(message.text)), {
            once: true,
          });
        }),
    ),
  );
  const result = new ResendEmailProvider('fixture-key', 'sender@example.test').sendEmail(message);
  controller.abort();
  await expect(result).rejects.toMatchObject({ message: 'network_error', retryable: true });
});

it.each([{}, { id: message.text }, { id: null }])(
  'does not invent a receipt for malformed acceptance %j',
  async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(
      new ResendEmailProvider('fixture-key', 'sender@example.test').sendEmail(message),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
  },
);

it('keeps development preview private and never calls the provider', async () => {
  const log = vi.spyOn(console, 'log');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const provider = createEmailProvider({ NODE_ENV: 'development', EMAIL_DELIVERY_MODE: 'preview' });
  expect(provider).toBeInstanceOf(ConsoleEmailProvider);
  expect(await provider.sendEmail(message)).toEqual({ kind: 'preview' });
  expect(log).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('fails production startup when credentials/sender are missing or preview is configured', async () => {
  for (const env of [
    {},
    { RESEND_API_KEY: 'fixture-key' },
    { EMAIL_DELIVERY_MODE: 'preview' },
    { EMAIL_DELIVERY_MODE: 'unknown' },
  ]) {
    expect(() => createEmailProvider({ ...env, NODE_ENV: 'production' })).toThrow(
      'configuration_missing',
    );
  }
  const unavailable = createEmailProvider({
    NODE_ENV: 'development',
    EMAIL_DELIVERY_MODE: 'resend',
  });
  expect(unavailable).toBeInstanceOf(UnavailableEmailProvider);
  await expect(unavailable.sendEmail(message)).rejects.toMatchObject({
    code: 'configuration_missing',
    retryable: false,
  });
  expect(
    createEmailProvider({
      NODE_ENV: 'production',
      RESEND_API_KEY: 'fixture-key',
      EMAIL_FROM_ADDRESS: 'sender@example.test',
    }),
  ).toBeInstanceOf(ResendEmailProvider);
});
