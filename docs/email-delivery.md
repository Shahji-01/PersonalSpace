# Transactional email delivery

## Delivery-state foundation

Migration **0044** adds recipient/sender/HTML snapshots, expiry, attempt count, retry time, claim identity/lease expiry, provider reference/acceptance time and a constrained diagnostic code to `notification_log`. The Drizzle schema exposes these fields. Apply forward migrations before running code that selects the expanded notification schema; this increment was exercised only in isolated databases.

The existing notification UUID is the stable logical delivery identifier. Once `email_first_attempt_at` is set, a trigger prevents changes to its identifier, owner, channel, dedupe key, subject, body, recipient, sender, HTML or first-attempt timestamp. Retries must reuse that envelope. Claim ID and lease expiry must be present together; email processing requires a claim and a positive attempt count. Diagnostic codes accept only the documented finite categories, never raw provider response text.

Existing pending, sent and failed outcomes are preserved. Migration does not claim work, resend old messages or invent provider acceptance for historical console sends. Historical rows have no snapshotted recipient; the delivery implementation must handle them explicitly rather than assume their current account email is the originally intended destination.

The owner policy now applies explicitly to the application role and fails closed when no account context is set. The maintenance role retains its existing cross-user delivery permissions; this is not a new general-purpose grant. Auth and sync-relay roles cannot read notification delivery records, and maintenance cannot read auth password fields or unrelated profile columns. Existing account-erasure fencing and notification deletion cover the new fields automatically.

## Claims and delivery

The worker claims one due row at a time using PostgreSQL `FOR UPDATE SKIP LOCKED`. Each claim has a fresh UUID and a two-minute lease. An expired lease can be recovered; a stale worker cannot submit or overwrite a newer claim. The recipient is captured at enqueue time, and the sender is frozen with the first attempt. Legacy messages without a recipient snapshot fail with `recipient_missing`, rather than guessing the intended address from a changed account profile.

Submission holds the notification row lock and the existing account-deletion fence through the bounded provider request. An erasing account is excluded, and deletion cannot start while its in-flight request holds that fence. A process/database failure after provider acceptance leaves the durable claim recoverable. Recovery reuses `personalspace/email/<notification UUID>` and the identical payload.

Transient failures use exponential backoff starting at 30 seconds, capped at one hour, with at most eight attempts. A longer provider `Retry-After` is respected only within the message expiry and retry window. Retries stop 23 hours after the first attempt, safely inside [Resend's documented 24-hour idempotency window](https://resend.com/changelog/idempotency-keys). A long outage produces `delivery_uncertain`; it must not cause automatic resubmission with a new key. This is bounded idempotent recovery, not a guarantee that every accepted email reaches an inbox.

Resend requests time out after ten seconds and do not follow redirects. HTTP 429, 408, server errors and concurrent idempotency conflicts are retryable; permanent rejection and changed-payload conflicts are terminal. Provider payloads, recipients, tokens and raw database errors are never included in operational diagnostics. Only a validated provider reference and a constrained diagnostic category are persisted.

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `pending`    | Queued; no claim yet                                              |
| `processing` | Leased by a worker                                                |
| `retrying`   | Recoverable failure; retry time recorded                          |
| `accepted`   | Provider returned an acceptance reference; delivery is not proven |
| `preview`    | Development-only simulation; nothing sent                         |
| `failed`     | Terminal diagnostic category; no automatic resubmission           |
| `sent`       | Historical outcome retained by migration; not reprocessed         |

No delivery webhook/receipt consumer is implemented yet. `sent_at` is not populated by new acceptance or preview outcomes. Worker logs report `emails_accepted`, and database failures fail the queue job with a sanitized error instead of silently completing it.

## Provider setup

Set `EMAIL_DELIVERY_MODE=resend`, `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` using a verified sender. Never commit credentials. Development defaults to `preview` without a key; `.env.example` makes that choice explicit. An incomplete or unknown development provider configuration records `configuration_missing`. Production worker startup rejects missing credentials, a missing sender or preview mode. The application's separate production release gate remains in place.

Preview mode stores the envelope in the owner-scoped notification record without printing it. It is not an email inbox and does not establish link-flow acceptance. Fixing configuration does not automatically replay terminal/preview records; use a fresh, intentional user action to queue a new logical message.

## Remaining work

Required auth/account/export enqueue integration, surfaced enqueue failures and all v1.0 templates remain in tasks 2.4-2.6. Existing enqueue callers do not yet all provide recipient snapshots and must be completed before this is an end-to-end release feature. No provider credentials or actual messages were used in the migration, concurrency or provider-fixture tests; real-provider acceptance remains in group 21.
