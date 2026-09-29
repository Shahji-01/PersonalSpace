# ADR-013 — Better Auth evaluation

Status: Proposed; implemented for local evaluation, not accepted for launch.

Evaluate Better Auth with its Drizzle adapter, Fastify Fetch handler, and bearer plugin for the first native flow. Argon2id is configured explicitly. Auth DB access is isolated from product DB access. Native tokens are held in Expo SecureStore.

The initial implementation uses opaque, revocable seven-day sessions. This differs from specification §57's short-lived access JWT plus rotating refresh token family. Do not silently accept the difference: evaluate the required JWT/refresh design, session storage, rate limits, re-authentication, token reuse, OAuth and email lifecycle before the Phase 0 decision.

Public signup and production deployment are not enabled. The preview age/acceptance fields do not replace versioned final consent records.

References consulted for the initial integration:

- https://better-auth.com/docs/integrations/fastify
- https://better-auth.com/docs/plugins/bearer
- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/authentication/email-password

Acceptance evidence must include cross-account tests, revocation tests, email delivery, OAuth on both devices, refresh-family reuse, account deletion and the provider cost/security review.
