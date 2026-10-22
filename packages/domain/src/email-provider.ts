export interface EmailEnvelope {
  idempotencyKey: string;
  to: string;
  from: string | null;
  subject: string;
  text: string;
  html: string | null;
}
export type EmailOutcome = { kind: 'accepted'; providerId: string } | { kind: 'preview' };
export interface EmailProvider {
  readonly fromAddress: string | null;
  sendEmail(email: EmailEnvelope): Promise<EmailOutcome>;
}
type FailureCode =
  | 'configuration_missing'
  | 'expired'
  | 'delivery_uncertain'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'network_error';
export class EmailDeliveryError extends Error {
  constructor(
    readonly code: FailureCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'EmailDeliveryError';
  }
}

/** Development preview records state only; private content is never logged. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly fromAddress = 'PersonalSpace <preview@example.invalid>';
  async sendEmail(): Promise<EmailOutcome> {
    return { kind: 'preview' };
  }
}

export class UnavailableEmailProvider implements EmailProvider {
  readonly fromAddress = null;
  async sendEmail(): Promise<EmailOutcome> {
    throw new EmailDeliveryError('configuration_missing', false);
  }
}

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    readonly fromAddress: string,
  ) {}

  async sendEmail(email: EmailEnvelope): Promise<EmailOutcome> {
    if (!this.apiKey || !email.from) throw new EmailDeliveryError('configuration_missing', false);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        }),
      });
      if (!response.ok) {
        const payload: unknown =
          response.status === 409 ? await response.json().catch(() => null) : null;
        const concurrent =
          payload !== null &&
          typeof payload === 'object' &&
          'name' in payload &&
          payload.name === 'concurrent_idempotent_requests';
        const throttled = response.status === 429;
        const transient = response.status >= 500 || response.status === 408 || concurrent;
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
        const retryAfterMs = Number.isFinite(seconds)
          ? Math.min(seconds * 1000, 24 * 60 * 60_000)
          : undefined;
        await response.body?.cancel().catch(() => undefined);
        throw new EmailDeliveryError(
          throttled
            ? 'provider_rate_limited'
            : transient
              ? 'provider_unavailable'
              : 'provider_rejected',
          throttled || transient,
          retryAfterMs,
        );
      }
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('id' in payload) ||
        typeof payload.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id)
      ) {
        throw new EmailDeliveryError('provider_unavailable', true);
      }
      return { kind: 'accepted', providerId: payload.id };
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError('network_error', true);
    }
  }
}

export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const mode = env.EMAIL_DELIVERY_MODE ?? (env.RESEND_API_KEY ? 'resend' : 'preview');
  if (mode === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS) {
    return new ResendEmailProvider(env.RESEND_API_KEY, env.EMAIL_FROM_ADDRESS);
  }
  // A production process must not start under preview or missing configuration.
  if (env.NODE_ENV === 'production') throw new EmailDeliveryError('configuration_missing', false);
  if (mode === 'preview') return new ConsoleEmailProvider();
  return new UnavailableEmailProvider();
}
