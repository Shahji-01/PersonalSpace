/**
 * Transactional Email Worker (§70, M5).
 *
 * Processes pending email notifications from the notificationLog
 * and delivers them using a configured email provider.
 * Falls back to logging in development if no provider is configured.
 */

import { eq, and } from 'drizzle-orm';
import { notificationLog, authUsers, type Database } from '@personalspace/db';

export interface EmailProvider {
  sendEmail(to: string, subject: string, body: string, html?: string): Promise<void>;
}

/** Mock provider for development. */
export class ConsoleEmailProvider implements EmailProvider {
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    console.log(`[EMAIL DISPATCH] To: ${to} | Subject: ${subject}`);
    console.log(`[EMAIL BODY]:\n${body}`);
  }
}

/**
 * Resend email provider (https://resend.com).
 * Uses the HTTP API directly — no SDK dependency.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string = 'PersonalSpace <noreply@personalspace.app>',
  ) {}

  async sendEmail(to: string, subject: string, body: string, html?: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [to],
        subject,
        text: body,
        ...(html ? { html } : {}),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Resend API error ${response.status}: ${errorBody}`);
    }
  }
}

/**
 * Factory: pick provider based on environment configuration.
 * Falls back to ConsoleEmailProvider when no API key is set.
 */
export function createEmailProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (apiKey) {
    return new ResendEmailProvider(apiKey, fromAddress || undefined);
  }
  return new ConsoleEmailProvider();
}

/**
 * Worker job to process and send pending emails.
 * Returns the number of emails processed.
 */
export async function processPendingEmails(db: Database, provider: EmailProvider): Promise<number> {
  const pending = await db
    .select({
      id: notificationLog.id,
      userId: notificationLog.userId,
      title: notificationLog.title,
      body: notificationLog.body,
    })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.channel, 'email'),
        eq(notificationLog.status, 'pending')
      )
    )
    .limit(50); // Batch size

  if (pending.length === 0) return 0;

  let count = 0;
  for (const log of pending) {
    // Look up the user's email address
    const user = await db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, log.userId))
      .then((rows) => rows[0]);

    if (!user || !user.email) {
      await db
        .update(notificationLog)
        .set({ status: 'failed', error: 'User email not found', sentAt: new Date() })
        .where(eq(notificationLog.id, log.id));
      continue;
    }

    try {
      await provider.sendEmail(
        user.email,
        log.title,
        log.body || '',
      );

      await db
        .update(notificationLog)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(notificationLog.id, log.id));
      
      count++;
    } catch (e) {
      await db
        .update(notificationLog)
        .set({ status: 'failed', error: String(e), sentAt: new Date() })
        .where(eq(notificationLog.id, log.id));
    }
  }

  return count;
}
