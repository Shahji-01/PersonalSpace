# Attachment uploads and transfer queue

The resumable transfer engine, account-scoped SQLite queue, authenticated upload API and private S3 adapter are implemented. It does **not** enable attaching files in the editor yet. Uploaded objects remain in quarantine with a `processing` status; scanning/re-encoding, download grants, durable native file copies and picker/editor integration remain to be implemented.

## Server upload flow

Migration 0027 adds owner-scoped attachment metadata with forced RLS and parent ownership FKs. Attachments have their own entity versions and sync records, so upload status never changes the note's content version. Sync carries the display filename, declared MIME, size, hash and status; it excludes storage keys, multipart IDs and credentials. Update API and mobile together when applying the migration.

- `POST /api/v1/attachments/uploads` accepts `{ descriptor, sessionId }`. Registration is idempotent by attachment ID and immutable descriptor. The server returns authoritative upload progress or processing/rejection status; an old session ID never overrides current server state.
- `POST /api/v1/attachments/:id/parts` accepts `{ sessionId, number }` and returns a five-minute PUT grant with required headers. Keys are random `u/<userId>/<uuid>` values. Single PUTs bind the declared SHA-256; multipart grants bind the exact part size and upload session.
- `POST /api/v1/attachments/:id/complete` accepts `{ sessionId, parts }`, checks actual object-store parts/size, and publishes a processing event exactly once. Retries reconcile completed objects. Multipart full-file hash validation is still a processing-worker requirement.
- `POST /api/v1/attachments/:id/cancel` idempotently purges an unfinished attachment, publishes its tombstone and queues object cleanup.

Registration serializes quota and rate checks with other writes for that account: 1 GiB reserved across pending/processing/ready and trashed files, and 60 new attachments per hour. Cancellation does not erase rate history. Existing-ID retries do not consume another reservation. These are the development free-tier limits; paid-plan entitlement support remains open. Object-store network calls run outside the row-sync transaction lock.

Trashing/restoring a note cascades to its attachment metadata. Permanent purge deletes the metadata and scrubs it from cached command responses, while reserving deletion markers. The worker relays durable `attachments.cleanup` events to a deduplicated BullMQ queue, waits ten minutes for outstanding grants to expire, then aborts multipart uploads and deletes objects with retries. Cleanup validates the object-key owner. Parent Trash retention automation and account-wide erasure remain pending.

## Local storage service

The optional Compose `attachments` profile builds MinIO from the pinned official [source release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z), since upstream container pulls are unavailable. The small `infra/storage` build context excludes application files and secrets. This is a loopback-bound development/test service, not a production hosting choice; its license is included in the image. The first source build takes several minutes; Docker caches it for subsequent runs.

1. Run `docker compose --profile attachments up -d --build storage`.
2. Add the commented `S3_*` settings from `.env.example` to your local `.env`.
3. Run `node --env-file=.env --import tsx scripts/setup-storage.ts`. This command requires a loopback endpoint and configures a private bucket plus quarantine expiration after seven days. It replaces that development bucket's lifecycle configuration. This MinIO version does not support the S3 incomplete-multipart lifecycle rule; cancellation explicitly aborts uploads, and abandoned uploads also depend on MinIO's own stale-upload cleanup. Production bucket provisioning must configure and verify incomplete-multipart expiration with its provider.
4. Apply `pnpm db:migrate`, then restart API/worker when convenient. The API checks configured storage in readiness. Without `S3_BUCKET`, upload endpoints return 503 and existing text features continue working.

`S3_PUBLIC_ENDPOINT` is the device-visible address used for signing (for example `http://10.0.2.2:9000` for Android's emulator). The server uses `S3_ENDPOINT` for its own requests. Never rewrite signed URL hosts on the client. This increment does not change the running emulator or enable downloads of unvalidated files.

## Queue behavior

The shared descriptor uses an attachment UUID, parent UUID, display filename, declared MIME, byte size and lowercase SHA-256. Files are limited to 25 MiB. A local transfer stores a durable `file:///` URI, revision, multipart session, acknowledged ETags, state and retry deadline. Filenames reject path separators and control characters. Client MIME/hash declarations are not server validation.

`createAttachmentTransferEngine` has its own queue and never calls or awaits row sync. The host creates one consumer for the signed-in account and calls `drain()` when connectivity/foreground state changes, an upload is enqueued, or the returned `nextAttemptAt` arrives. Concurrent calls share a single run. A failed file does not prevent later eligible files from being attempted.

Files larger than 5 MiB use 5 MiB parts. The server's session and completed-part list are authoritative on every resume, including a crash between a successful PUT and its SQLite acknowledgement. An expired session can be replaced without reusing stale ETags. Before sending missing parts, the native adapter must recheck the local file's size and SHA-256. Completion is idempotent; `processing` is polled every 30 seconds and does not itself mean `ready`.

Files larger than 10 MiB require Wi-Fi by default; the host can supply the user's cellular override. The engine checks connectivity before each part and before completion. Small files can proceed while a large file waits. OS background execution is not implemented.

Transient failures persist exponential backoff with equal jitter (1–2 seconds initially, up to 2.5–5 minutes), respecting a longer server retry delay across restarts. Auth failures pause the account's transfer queue until explicit `resumeAfterAuthentication()`. Rejection, changed/missing local files and invalid upload responses remain failed for review. Adapters should map failures to `AttachmentTransferError`; arbitrary error text and signed URLs are never saved as errors. Each adapter operation has a 60-second timeout and receives an abort signal. Disposal aborts in-flight work and ignores late responses.

## SQLite and deletion

The mobile store exposes `attachmentTransfers`. All operations filter by account and use the existing serialized SQLite write transactions. Enqueue is idempotent only for the same descriptor and URI. Progress replacement requires the previous revision and cannot insert a missing row, change identity or overwrite newer state.

Parent or attachment purge atomically erases queue metadata, reserves the cancelled attachment ID, and records only the local URI in a file-removal queue. A late upload response cannot resurrect it. Ordinary cancellation follows the same path. The filesystem adapter must delete each file (or confirm it is absent) **before** acknowledging its removal; a failed deletion leaves the URI queued. File removal is not executed by this increment. No cache-clearing operation is exposed that could discard unsynced bytes.

## Remaining integration

- Download grants, full-file server hash verification, deduplication and paid-plan storage quotas.
- Processing worker: MIME sniffing, image re-encoding/EXIF removal/thumbnails and document scanning. `attachments.process` events stay durable until this worker is implemented; objects are never marked ready by the upload API.
- Native picker, durable account-scoped file copies, hashing/PUT adapter and actual file-removal execution.
- Attachment-ID editor nodes, progress/retry UI and other-device placeholders.
- Connectivity/foreground scheduling, configurable 500 MiB LRU cache, pinned offline files, lazy downloads and eager recent thumbnails.
- Retention/account deletion across objects and local files; real-device interruption and app-kill acceptance.

The engine's unit tests exercise interrupted/expired sessions, lost acknowledgements, retry deadlines, network policy, auth pause, cancellation and timeouts. Actual SQLite queries are exercised through the mobile store tests, with only Expo's native binding replaced. The integration suite also exercises PostgreSQL and a real private S3-compatible server; its current results are recorded in [verification.md](verification.md). Native file transfers and real-device acceptance remain open.
