# Offline sync scheduling

The account-scoped SQLite outbox remains the durable source of pending mutations. Sync first pulls current state/deletion markers, then pushes ordered batches, applies explicit acknowledgements and pulls again after writes. A failed request preserves the mutation and its original idempotency key. Rejected domain mutations remain visible for review; transport retries do not silently turn them into new writes.

Foreground sync polls every 30 seconds while healthy. Local changes request an immediate sync; changes queued after an in-flight run has read the outbox trigger a follow-up run on success. Requests never overlap. Network/server failures retry with exponential backoff and equal jitter, starting at 1–2 seconds and reaching a 2.5–5 minute cap. A successful run resets the delay. New local changes and foreground transitions respect an existing failure delay.

HTTP Retry-After seconds and dates are honored, including non-JSON proxy error responses. Pull-to-refresh can bypass local backoff but still respects the server's delay. Authentication/authorization failures pause automatic attempts; explicit refresh or signing in can retry. The status line shows the next retry time or paused state. Going to the background cancels scheduled timers, returning resumes them, and signing out/unmounting disposes the scheduler. An already-running request can finish without scheduling another background run.

Retry timers are in memory and reset after an app restart; outbox items, drafts and cursors persist in SQLite. OS background execution and connectivity event integration, versioned SQLite migrations and the complete v1.1 conflict policy remain separate work. This implementation does not promise background delivery while the OS suspends the app.

Fake-clock tests cover increasing/capped/reset delays, server delays, auth pause/manual retry, in-flight changes, background transitions and disposal. Existing actual-SQLite and replay tests verify durable mutations and stable retry keys. Native connectivity and app-kill acceptance remain open.

## Expired cursors and recovery

Permanent-deletion markers leave incremental sync after 180 days. A cursor below the highest expired marker, or ahead of the account's current version, receives HTTP 410 `RESYNC_REQUIRED`. The client persists an account-scoped recovery flag, resets its cursor and pulls `mode=full` pages before replaying queued changes. Each page merges records/deletions and its cursor in one SQLite transaction. A network failure or app restart resumes the stored full-mode cursor. The flag clears only after the final page; that page advances to the account watermark even when its latest writes produced only history checkpoints.

Recovery does not blindly clear the cache. Existing records, local captures, mutation IDs and drafts remain available while pages merge. Pending content edits stay optimistic until acknowledged or rejected. Full mode includes all reserved purge markers, including expired ones, so deletion removes cached private content, history, drafts and queued edits. Deleting a source note also cancels unacknowledged draft-copy requests. Already published copies are independent notes and remain available. A server rejection resets the cursor for authoritative refresh while preserving unfinished drafts.

Minimal UUID/owner/version reservations remain on the server to prevent ID reuse and preserve reference integrity; only their availability in incremental sync expires. Physical reservation compaction remains open. Full-mode pages use repeatable-read transactions and version boundaries like ordinary pulls. Owner isolation and interrupted recovery are tested with PostgreSQL, the sync engine and actual SQLite.
