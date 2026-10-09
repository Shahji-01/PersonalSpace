# Account deletion — 9 October 2026

## Request and cancellation

The authenticated request, status and cancellation endpoints use account-scoped database transactions. Creating a request also queues its confirmation email in the same transaction. Concurrent requests cannot extend the grace period. A cancelled request can be requested again; running and completed requests cannot be overwritten. Cancellation succeeds only before the 14-day deadline and before processing has started.

Settings shows the deadline with date and time, offers cancellation during the grace period, and distinguishes scheduled, processing and completed states. Native interaction/accessibility acceptance remains open.

## Worker lifecycle

The worker registers the hourly deletion schedule while running, with retries after registration failure. Repeated or concurrent starts preserve one repeat definition, including older installations. Other background schedule/retention repairs remain separate work.

1. Claim an expired request atomically. Database triggers serialize the claim against writes already in flight and block subsequent writes from application, authentication and background roles. Sessions and password-reset tokens are revoked. Failed attempts remain fenced.
2. Persist attachment and cleanup-outbox keys in the deletion ledger before removing database rows. Clean owned attachment/export objects, versions and delete markers, and abort multipart uploads. Missing storage or failed deletion leaves the request retryable; it cannot report success.
3. Remove domain content, Inbox provenance, recurrence rules, cached idempotent responses, sync state, search entries, notification/device/preferences records, exports, outbox and audit rows. Remove authentication accounts/sessions and anonymize the user row that anchors the ledger.
4. Keep processing until at least ten minutes after the initial claim. Existing upload grants last five minutes. A second storage sweep catches late uploads before completion. Retained exact keys also allow this sweep after attachment rows/outbox events have been erased.
5. Clear retained keys and the supplied reason on completion. Attempts abandoned for fifteen minutes can be reclaimed; stale attempts cannot overwrite a newer claim's status. Per-attempt errors are generic and do not retain provider bodies.

Storage calls have timeouts and a cleanup pass has a one-minute work budget. Objects already removed stay removed on retry. Very large accounts still require scale testing and durable progress within the key enumeration to avoid repeated scanning exhausting that budget.

MinIO's multipart listing requires an exact object key, so cleanup uses retained application keys in addition to S3 prefix enumeration. Unknown multipart sessions whose keys were lost before this implementation cannot be certified erased on that provider without a separate inventory. This behavior is documented in [MinIO's compatibility reference](https://minio.community/community/minio-object-store/reference/s3-api-compatibility.html) and was reproduced against the repository's pinned MinIO build.

## Applying and operating

Apply migration `0042_deletion_inventory.sql` before updating the API/worker. It adds cleanup state, account-write guards and narrowly scoped reset-token erasure. It also reopens deletion requests previously marked completed by the old worker so their leftover objects and retry data can be swept. Existing cancelled requests remain cancelled.

The storage identity needs permission to list object versions/multipart uploads and delete versions/abort uploads under owned prefixes. Bucket object-lock/retention restrictions or missing permissions must leave deletion incomplete. No bucket policy is modified at startup. The worker needs its configured maintenance database role and storage connection.

The implementation covers the live PostgreSQL database and configured object bucket. Backup copies, replicas, external email/OAuth providers, logs outside this pipeline, device erasure acceptance, recent reauthentication and production/legal acceptance remain release gates. This is not a certification of complete erasure across those systems. Production remains gated.

See [verification](verification.md) for the checks run with isolated data. The user's running database, services and emulator were not changed in this implementation pass.
