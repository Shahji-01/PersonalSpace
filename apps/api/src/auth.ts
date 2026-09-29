import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { hash, verify } from '@node-rs/argon2';
import { v7 as uuidv7 } from 'uuid';
import {
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  type Database,
} from '@personalspace/db';
import type { ServerConfig } from '@personalspace/config';

export function createAuth(db: Database, config: ServerConfig) {
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
    },
    user: {
      additionalFields: {
        ageConfirmed: { type: 'boolean', required: true },
        termsAccepted: { type: 'boolean', required: true },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      database: { generateId: () => uuidv7() },
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [bearer()],
  });
}
