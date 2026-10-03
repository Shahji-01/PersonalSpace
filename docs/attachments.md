# Attachment uploads and transfer queue

The resumable transfer engine, account-scoped SQLite queue, authenticated upload API, private S3 adapter, processing worker and private downloads are implemented. It does **not** enable attaching files in the editor yet. Processing requires a configured scanner and restricted database connection; without them, files stay quarantined. Durable native file copies and picker/editor integration remain to be implemented.

## Server upload flow

Migration 0027 adds owner-scoped attachment metadata with forced RLS and parent ownership FKs. Attachments have their own entity versions and sync records, so upload status never changes the note's content version. Sync carries the display filename, declared MIME, size, hash and status; it excludes storage keys, multipart IDs and credentials. Update API and mobile together when applying the migration.

- `POST /api/v1/attachments/uploads` accepts `{ descriptor, sessionId }`. Registration is idempotent by attachment ID and immutable descriptor. The server returns authoritative upload progress or processing/rejection status; an old session ID never overrides current server state.
- `POST /api/v1/attachments/:id/parts` accepts `{ sessionId, number }` and returns a five-minute PUT grant with required headers. Keys are random `u/<userId>/<uuid>` values. Single PUTs bind the declared SHA-256; multipart grants bind the exact part size and upload session.
- `POST /api/v1/attachments/:id/complete` accepts `{ sessionId, parts }`, checks actual object-store parts/size, and publishes a processing event exactly once. Retries reconcile completed objects. The worker verifies the full-file hash for both single and multipart uploads before release.
- `POST /api/v1/attachments/:id/cancel` idempotently purges an unfinished attachment, publishes its tombstone and queues object cleanup.

Registration serializes quota and rate checks with other writes for that account: 1 GiB reserved across pending/processing/ready and trashed files, and 60 new attachments per hour. Quota uses the larger of original/processed size plus thumbnail size, and the processor checks it again before releasing output. Cancellation does not erase rate history. Existing-ID retries do not consume another reservation. These are the development free-tier limits; paid-plan entitlement support remains open. Object-store network calls run outside the row-sync transaction lock.

Trashing/restoring a note cascades to its attachment metadata. Permanent purge deletes the metadata and scrubs it from cached command responses, while reserving deletion markers. The worker relays durable `attachments.cleanup` events to a deduplicated BullMQ queue, waits ten minutes for outstanding grants to expire, then aborts multipart uploads and deletes objects with retries. Cleanup validates the object-key owner. Parent Trash retention automation and account-wide erasure remain pending.

## Local storage service

The optional Compose `attachments` profile builds MinIO from the pinned official [source release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z), since upstream container pulls are unavailable. The small `infra/storage` build context excludes application files and secrets. This is a loopback-bound development/test service, not a production hosting choice; its license is included in the image. The first source build takes several minutes; Docker caches it for subsequent runs.

1. Run `docker compose --profile attachments up -d --build storage`.
2. Add the commented `S3_*` settings from `.env.example` to your local `.env`.
3. Run `node --env-file=.env --import tsx scripts/setup-storage.ts`. This command requires a loopback endpoint and configures a private bucket plus quarantine expiration after seven days. It replaces that development bucket's lifecycle configuration. This MinIO version does not support the S3 incomplete-multipart lifecycle rule; cancellation explicitly aborts uploads, and abandoned uploads also depend on MinIO's own stale-upload cleanup. Production bucket provisioning must configure and verify incomplete-multipart expiration with its provider.
4. Apply `pnpm db:migrate`, then restart API/worker when convenient. The API checks configured storage in readiness. Without `S3_BUCKET`, upload endpoints return 503 and existing text features continue working.

`S3_PUBLIC_ENDPOINT` is the device-visible address used for signing (for example `http://10.0.2.2:9000` for Android's emulator). The server uses `S3_ENDPOINT` for its own requests. Never rewrite signed URL hosts on the client. Downloads require a successfully processed file.

## Processing and downloads

Migration 0028 adds processed-output metadata, rejection reasons and processing leases. It creates the `personalspace_attachment_processor` role without a login/password; provision its login through your database administrator and supply `ATTACHMENT_DATABASE_URL` to the worker. The role has owner-scoped RLS and only attachment metadata, attachment entity versions, account sync counters and event/audit writes. It cannot read notes, authentication data or financial content. The existing relay role keeps its metadata-only permissions.

Set `CLAMAV_HOST` and optionally `CLAMAV_PORT` (default 3310), plus the storage configuration. The scanner must be on a trusted private connection: the clamd TCP protocol has no application authentication or TLS. Maintain its signatures with FreshClam. Required daemon settings include `StreamMaxLength 26M`, `MaxFileSize 26M`, `MaxScanSize 100M`, `AlertExceedsMax yes`, `AlertEncrypted yes`, `ScanPDF yes` and `ScanImage yes`; these prevent oversized or encrypted content being silently treated as scanned. See the upstream [clamd configuration reference](https://raw.githubusercontent.com/Cisco-Talos/clamav/main/etc/clamd.conf.sample). Provisioning, signature freshness monitoring and live scanner acceptance are deployment work; no scanner or processor credentials are enabled automatically.

The worker consumes durable `attachments.process` events through BullMQ at concurrency one. Each attempt reserves fresh output keys in PostgreSQL before touching storage, with a five-minute lease. Expired attempts can retry, but a stale worker cannot publish after a newer claim or cancellation. Abandoned outputs and purged files have durable delayed cleanup events. Twelve exponentially delayed attempts are retained for operator inspection on exhaustion. Network reads/writes have 15-second limits; scanner requests have a 30-second absolute deadline. Scanner errors, malformed replies and disconnections retry without releasing a download.

After checking the complete SHA-256 and size, the worker scans the original bytes and checks their detected MIME against the declaration. Text must be valid UTF-8 without binary control bytes. JPEG/PNG/WebP images are decoded with a 40-million-pixel limit, oriented, re-encoded as WebP without EXIF/ICC metadata, and given a thumbnail of at most 320×320. Each encoding has a ten-second limit. Animated images are rejected. HEIC decoding depends on the deployed Sharp/libvips build; unsupported input is rejected and HEIC device acceptance remains open. PDF/audio files retain their scanned bytes; this is signature detection and scanning, not document sanitization or full media decoding.

Released objects use separate private keys that were never exposed in upload grants, so a late upload cannot overwrite processed bytes. The original quarantine object is queued for cleanup. Sync includes processed MIME/size/hash, thumbnail availability and a bounded rejection reason, but never storage keys or leases. Image transformations therefore have a distinct download hash from the original upload descriptor.

`POST /api/v1/attachments/:id/download` accepts `{ variant: "file" | "thumbnail" }` (default `file`). It requires the owner, a live parent note and `ready` status, and returns `{ url, expiresAt, mime, size, sha256 }`. The client exposes `downloadAttachment`. Grants expire after 60 seconds and use attachment disposition with encoded filenames and private/no-store cache controls. Thumbnail hashes are currently null; full files have the processed-byte hash. Trash/purge prevents new grants immediately; a previously issued grant can remain usable until expiration or physical deletion.

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

- Deduplication and paid-plan storage quotas.
- Scanner provisioning/signature freshness monitoring, real malware/format acceptance, HEIC decoder deployment and operator retry tooling for exhausted processing jobs. WebM audio currently fails closed because the signature detector identifies its container as video; track-level audio validation remains open.
- Native picker, durable account-scoped file copies, hashing/PUT adapter and actual file-removal execution.
- Attachment-ID editor nodes, progress/retry UI and other-device placeholders.
- Connectivity/foreground scheduling, configurable 500 MiB LRU cache, pinned offline files, lazy downloads and eager recent thumbnails.
- Retention/account deletion across objects and local files; real-device interruption and app-kill acceptance.

The engine's unit tests exercise interrupted/expired sessions, lost acknowledgements, retry deadlines, network policy, auth pause, cancellation and timeouts. Actual SQLite queries are exercised through the mobile store tests, with only Expo's native binding replaced. The integration suite also exercises PostgreSQL and a real private S3-compatible server; its current results are recorded in [verification.md](verification.md). Native file transfers and real-device acceptance remain open.
