import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { hash, verify } from '@node-rs/argon2';
import { createSign } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authJwks,
  type Database,
} from '@personalspace/db';
import type { ServerConfig } from '@personalspace/config';

import { jwt } from 'better-auth/plugins';

// Apple's Sign in with Apple expects the OAuth "client secret" to be a short-lived
// ES256 JWT signed with the team's private key, not the raw key material. Build it
// synchronously from the configured team/key/private key so operators only supply
// the .p8 contents. Node signs ES256 in JOSE (ieee-p1363) form directly.
function appleClientSecret(input: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'ES256', kid: input.keyId, typ: 'JWT' });
  const payload = b64({
    iss: input.teamId,
    iat: now,
    exp: now + 60 * 60 * 24 * 180, // Apple caps the secret lifetime at 6 months.
    aud: 'https://appleid.apple.com',
    sub: input.clientId,
  });
  const signingInput = `${header}.${payload}`;
  // Env-provided PEMs commonly carry escaped newlines; restore them before signing.
  const key = input.privateKey.replace(/\\n/g, '\n');
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export type AuthEmail = {
  userId: string;
  to: string;
  subject: string;
  body: string;
  dedupeKey: string;
};

export function createAuth(
  db: Database,
  config: ServerConfig,
  enqueueEmail?: (email: AuthEmail) => Promise<void>,
) {
  // Transactional emails (verification, password reset) are queued through the
  // notification log and delivered by the email worker. A failure to enqueue must
  // never block the auth operation itself.
  const send = async (email: AuthEmail) => {
    if (!enqueueEmail) return;
    try {
      await enqueueEmail(email);
    } catch {
      /* delivery is best-effort; surfaced via worker logs */
    }
  };
  return betterAuth({
    appName: 'PersonalSpace',
    // Provider diagnostics can include raw callback URLs. API middleware logs only
    // route templates, status, request ID and timing for authentication requests.
    logger: { disabled: true },
    baseURL: config.API_URL,
    basePath: '/api/auth',
    secret: config.AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        jwks: authJwks,
      },
    }),
    trustedOrigins: [config.WEB_URL, 'personalspace://'],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      password: {
        hash: (password) => hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        verify: ({ hash: encoded, password }) => verify(encoded, password),
      },
      sendResetPassword: async ({ user, url }) => {
        await send({
          userId: user.id,
          to: user.email,
          subject: 'Reset your PersonalSpace password',
          body: [
            `Hi ${user.name},`,
            '',
            'We received a request to reset your password. Open this link to choose a new one:',
            url,
            '',
            'If you did not request this, you can safely ignore this email.',
            '',
            '— PersonalSpace',
          ].join('\n'),
          dedupeKey: `reset_${user.id}_${Date.now()}`,
        });
      },
    },
    // Verification is sent on sign-up but not required, so the development slice
    // keeps working while the flow is exercised end to end.
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await send({
          userId: user.id,
          to: user.email,
          subject: 'Verify your PersonalSpace email',
          body: [
            `Hi ${user.name},`,
            '',
            'Confirm your email address by opening this link:',
            url,
            '',
            '— PersonalSpace',
          ].join('\n'),
          dedupeKey: `verify_${user.id}_${Date.now()}`,
        });
      },
    },
    user: {
      additionalFields: {
        ageConfirmed: { type: 'boolean', required: true },
        termsAccepted: { type: 'boolean', required: true },
      },
    },
    session: {
      // With JWT enabled, this affects the refresh token lifespan in the database.
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      database: { generateId: () => uuidv7() },
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    socialProviders: {
      ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(config.APPLE_CLIENT_ID &&
      config.APPLE_TEAM_ID &&
      config.APPLE_KEY_ID &&
      config.APPLE_PRIVATE_KEY
        ? {
            apple: {
              clientId: config.APPLE_CLIENT_ID,
              clientSecret: appleClientSecret({
                clientId: config.APPLE_CLIENT_ID,
                teamId: config.APPLE_TEAM_ID,
                keyId: config.APPLE_KEY_ID,
                privateKey: config.APPLE_PRIVATE_KEY,
              }),
            },
          }
        : {}),
    },
    plugins: [
      bearer(),
      jwt({
        jwt: {
          expirationTime: '15m', // Short-lived access token
        },
      }),
    ],
  });
}
