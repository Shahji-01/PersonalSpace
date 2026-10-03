# Attachment transfer foundation

This increment implements the resumable transfer engine and account-scoped SQLite queue required by specification §46.8. It does **not** enable attaching files in the editor yet. The API/storage transport, durable native file-copy adapter and picker/editor integration remain to be implemented.

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

- Attachment metadata/entity sync, owner validation and parent lifecycle on the server.
- Private S3-compatible storage, five-minute upload/download grants, multipart API, quota/rate limits, server hash verification and deduplication.
- Processing worker: MIME sniffing, image re-encoding/EXIF removal/thumbnails, document scanning, rejected-object and expired-upload cleanup.
- Native picker, durable account-scoped file copies, hashing/PUT adapter and actual file-removal execution.
- Attachment-ID editor nodes, progress/retry UI and other-device placeholders.
- Connectivity/foreground scheduling, configurable 500 MiB LRU cache, pinned offline files, lazy downloads and eager recent thumbnails.
- Retention/account deletion across objects and local files; real-device interruption and app-kill acceptance.

The engine's tests use a fake transport to exercise interrupted/expired sessions, lost acknowledgements, retry deadlines, network policy, auth pause, cancellation and timeouts. Actual SQLite queries are exercised through the mobile store tests, with only Expo's native binding replaced. These checks do not validate an S3 provider or a native file transfer.
