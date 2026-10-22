# Transactional email delivery

## Delivery-state foundation

Migration **0044** adds recipient/sender/HTML snapshots, expiry, attempt count, retry time, claim identity/lease expiry, provider reference/acceptance time and a constrained diagnostic code to `notification_log`. The Drizzle schema exposes these fields. Apply forward migrations before running code that selects the expanded notification schema; this increment was exercised only in isolated databases.

The existing notification UUID is the stable logical delivery identifier. Once `email_first_attempt_at` is set, a trigger prevents changes to its identifier, owner, channel, dedupe key, subject, body, recipient, sender, HTML or first-attempt timestamp. Retries must reuse that envelope. Claim ID and lease expiry must be present together; email processing requires a claim and a positive attempt count. Diagnostic codes accept only the documented finite categories, never raw provider response text.

Existing pending, sent and failed outcomes are preserved. Migration does not claim work, resend old messages or invent provider acceptance for historical console sends. Historical rows have no snapshotted recipient; the delivery implementation must handle them explicitly rather than assume their current account email is the originally intended destination.

The owner policy now applies explicitly to the application role and fails closed when no account context is set. The maintenance role retains its existing cross-user delivery permissions; this is not a new general-purpose grant. Auth and sync-relay roles cannot read notification delivery records, and maintenance cannot read auth password fields or unrelated profile columns. Existing account-erasure fencing and notification deletion cover the new fields automatically.

## Remaining work

This is persistence support, not a completed sender. Atomic claims, expired-lease recovery, bounded retries, Resend idempotency/timeouts, truthful preview/acceptance outcomes, safe enqueue hooks and complete templates are tracked in OpenSpec tasks 2.2-2.6. The existing email runtime still uses its previous console fallback and error handling until those tasks land. No provider credentials or actual messages were used by these migration tests.
