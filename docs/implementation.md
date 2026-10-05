# Implementation status

## Current increment: development foundation + notes/tasks

See [the whole-project audit](project-audit.md) for specification coverage, defects addressed, remaining work and migration order.

Implemented:

- [x] Strict TypeScript pnpm/Turborepo workspace, formatting/linting, CI definition.
- [x] Docker Compose PostgreSQL and Redis; separate owner, auth, app, and relay roles.
- [x] Forward-only SQL migrations with checksums and an advisory migration lock.
- [x] Drizzle schema, UUIDv7, composite ownership FKs, per-user version indexes, forced RLS.
- [x] Provisional Better Auth email/password signup/signin/signout using Argon2id.
- [x] Explicit adult/preview acceptance; secure native credential storage.
- [x] API validation, error envelopes, rate limiting, CORS, security headers, health/readiness and OpenAPI.
- [x] Create inbox items, plain-text notes (canonical document JSON), and tasks.
- [x] Complete/reopen tasks with version checks; atomic inbox conversion with provenance.
- [x] Idempotency, metadata-only audit entries, transactional outbox.
- [x] Mobile Today, all tasks, Library, Capture, meaningful empty/error/pending states.
- [x] Note editing, soft-delete to a Trash view, restore, and permanent purge, synced with version checks.
- [x] Task rescheduling (set/clear the planned date) and one level of subtasks with completion progress.
- [x] Task renaming and soft-delete to Trash with restore and permanent purge; trashing cascades to subtasks.
- [x] Tags on notes and tasks with client-side tag filtering (stored on the shared entity row).
- [x] Dismiss an unfiled inbox capture to Trash with restore and permanent purge.
- [x] Task priority (0–4) and a deadline separate from the planned date; Today shows due/overdue tasks and sorts by priority.
- [x] Note pin, favorite, and archive (orthogonal to Trash); a separate Archived view and pinned-first note ordering.
- [x] Full task status lifecycle (todo · in_progress · done · cancelled) with a status selector; cancelled tasks drop out of overdue.
- [x] Projects with colors, rename/edit, ordering, archive/unarchive, task filtering and atomic parent/subtask assignment.
- [x] Timed deadlines with floating/fixed timezone intent, explicit daylight-saving ambiguity handling and timezone-aware task views.
- [x] Recurring tasks with fixed/after-completion schedules, finite ends, weekdays/month ends, occurrence/future edit scope, idempotent successors and subtask copying.
- [x] Project-related notes with an offline link picker, ownership/version checks and synced cleanup on permanent deletion.
- [x] Project-related learning resources mirroring project-related notes: `project.setResources` command, a `related_resource` entity link, `relatedResourceIds` sync serialization, owner/version checks, version-bumped cleanup when a linked resource is permanently purged, and a mobile link picker.
- [x] Offline Today, next 7/30 days, Overdue, All tasks and recent Completed views, using separate planned/deadline dates and synced completion timestamps.
- [x] Rich-text note editing: headings, bold/italic, lists, checklists, quotes, links, code, undo/redo; native note previews and account-scoped SQLite drafts.
- [x] Structured note references with a `[[` picker, live title resolution, Linked from, draft-safe navigation, owner-validated relations and history/purge handling.
- [x] Shared versioned note-document schema, bounded input validation, server-derived text, formatted JSON in sync, and protection against legacy plain-text edits flattening rich notes.
- [x] Note folders: create, rename, move, empty-folder deletion, three-level depth/cycle checks, owner FKs/RLS, mobile management, filing and filtering.
- [x] Note version history at creation/content save/restore; paginated authenticated API, offline cache, preview and restore as a new version, retention of the latest 50 plus all versions within 30 days.
- [x] Ten-minute and session-end history checkpoints for changed notes, queued offline without publishing unfinished edits or erasing local drafts.
- [x] Permanent-purge markers in incremental sync, legacy-purge backfill, private-content erasure from retry responses/history, and mobile protection against deleted-record resurrection.
- [x] Backward-compatible cache response defaults and guards against stale acknowledgements and overlapping item mutations.
- [x] Repeatable mobile-width browser editor tests in CI, including draft recovery and storage failures.
- [x] Account-scoped durable SQLite cache/outbox, coalesced replay, incremental pull pages on version boundaries.
- [x] Attachment transfer foundation: resumable multipart engine, account-scoped SQLite progress/backoff, Wi-Fi policy and purge-safe cancellation. Authenticated upload API, private S3 grants, metadata sync, quota checks, processing/cleanup, scanner adapter and private downloads are implemented. Mobile Files adds picker/copy/hash, foreground transfers, progress/retry/removal, verified download/share, offline pins, configurable LRU storage, safe cache clearing, startup orphan reclamation and cleanup of confirmed completed-upload copies. Inline file labels, searchable insertion and draft-safe add/open actions are implemented. On-demand image previews in the editor and Files screen are implemented with verified, separate thumbnail storage. Recent thumbnails prefetch automatically with bounded batches, cancellation, retry delays and cache-capacity protection. Scanner provisioning and native device acceptance remain pending; see [attachment integration status](attachments.md).
- [x] Foreground sync backoff/jitter, server Retry-After, auth pause, manual retry and follow-up sync for edits queued during a running request.
- [x] Expired-cursor detection and resumable full recovery before replay, preserving queued changes while erasing old purged content.
- [x] Explicit recovery of conflicting rich note drafts as separate linked notes, with source preservation and acknowledgement-safe draft cleanup.
- [x] Worker publishes deduplicated sync signal jobs and maintains a monotonic Redis watermark.
- [x] Web landing page and explicitly marked privacy/terms drafts.
- [x] Unit and real-PostgreSQL integration test suites.
- [x] Reminders: standalone and entity-attached, floating/fixed timezone scheduling, fire_at computation, snooze (10 min/1 h/evening/tomorrow morning), dismiss/done/cancel lifecycle, Trash/restore/purge, RLS, incremental sync and search indexing.
- [x] Learning: collections (tree, max depth 3), resources (10 types, URL dedup, metadata/progress tracking, auto-completion at 90% for videos), collection CRUD, resource save/update/status/progress/collection/delete/restore/purge, RLS, incremental sync and search indexing.
- [x] Money: people, accounts, categories (two levels), transactions with sum-validated splits, tracking debts/receivables with statuses, revisions for audit trailing edits/voiding/restoring, incremental sync and search indexing.
- [x] Settings & Preferences: user preferences table with robust defaults, device token registration for push notifications, and idempotent notification delivery logging.
- [x] Background Data Export foundation: owner-scoped data collection and per-domain scopes under the background role (migration 0036), covered by an integration test. Worker/download scaffolding exists; correct CSV/Markdown artifacts, required durable storage before ready, expiry cleanup and user download acceptance remain open.
- [x] Account Deletion database foundation: a background-role worker (migration 0038) deletes account-owned application rows and retains a deletion-request ledger, with integration coverage. Auth-record erasure and actual object-storage cleanup are incomplete. This is not a completed account-erasure lifecycle or a compliance certification.
- [x] Maintenance Worker: nightly background cleanup for 30-day Trash, 180-day tombstones, 7-day idempotency keys, export expiry, and balance drift reconciliation. Runs under a dedicated least-privilege `personalspace_maintenance` role (migration 0033) so the sync relay stays restricted to outbox metadata. Covered by an integration test; two latent defects were fixed along the way (a broken `ANY(array)` binding in the Trash cleanup, and missing SELECT grants that `DELETE … WHERE` needs).
- [x] Learning Metadata: safe URL fetcher with SSRF protection, size limits, and regex-based OpenGraph/Twitter meta tag extraction in a background worker. Runs under the privileged background role (migration 0037 adds UPDATE/INSERT on learning_resources and INSERT on entities for playlist expansion). Covered by an integration test with a mocked fetch.
- [x] Reminders Delivery: background worker to push due reminders to registered device tokens idempotently. Runs under the privileged background role, skips devices that scheduled the reminder locally (watermark), dedupes per device/fire-time, and is owner-isolated. Covered by an integration test.
- [x] YouTube Integration: parse YouTube video/playlist URLs, fetch Data API v3 metadata, and expand playlists into child resources.
- [x] Transactional Email Worker foundation: notification-log processing under the background role, with a column-level `SELECT (id, email)` grant on `auth_user`, sent/failed state and integration coverage. The worker currently uses a console provider; real provider delivery and content-safe logging remain open.
- [x] Mobile "More" hub with Reminders, Learning and Money screens consuming the existing offline command/sync path (create/list/act across each domain). Native-device acceptance and richer sub-features (notification scheduling, in-app player, splits/debt UI) remain.

These checks mean code exists. Validation results are recorded separately in `docs/verification.md`; Phase 0 is **not** complete.

## Phase 0 exit gaps

- [ ] Discovery interviews and timed prototype tests with the specification's decision rules.
- [ ] Owner decisions: team, budget, provider accounts, domain, final product identifiers.
- [~] Google/Apple OAuth: server providers configured (Better Auth social providers + JWT plugin + `jwks` table; Apple client secret generated from team/key/private key) and mobile AuthScreen has Google/Apple buttons using a `Linking` redirect to `personalspace://oauth`. Remaining: real provider credentials, a native dev build, and the callback token-return/app-link verification. Verification/reset email still pending.
- [ ] Auth library evaluation and final ADR-013: short-lived mobile access tokens, rotating refresh families/reuse detection, re-auth, consent version/history, breach check, account lockout.
- [ ] Sync comparison spike against PowerSync and final ADR-011.
- [ ] Mobile rich-text editor spike with low-end Android, Hindi IME and accessibility measurements (ADR-027).
- [ ] Native share-extension/widget proof on Android and iOS; mobile end-to-end test harness.
- [ ] Approved onboarding/Figma flows and design system accessibility review.
- [ ] Staging/prod provisioning, secrets, automated deploy, rollback, instrumentation and backup drill.
- [ ] AI provider/Hinglish evaluation and STT spike.

## Next implementation increments

1. Finish the Phase 0 identity/account lifecycle and native build gates.
2. M1: rich notes/drafts/history/checkpoints, backlinks, daily notes, folders, tags/Trash, task descriptions/estimates/archive, statuses/views, timed deadlines, recurrence, priority, projects/related notes and one-level subtasks are implemented. Remaining: editor/native acceptance (ADR-027), attachments, versioned SQLite migrations and sync recovery/conflict work. Project-related learning resources are now implemented. One-level subtasks are the specified v1 scope.
3. M2: complete onboarding, richer deterministic parsing, widgets/share capture, local notification scheduling, real push delivery and the device delivery matrix. Reminder data/commands/sync, a mobile screen and background notification-log processing exist.
4. M3: complete player/progress workflows, metadata safety/provider acceptance and native interaction. Learning data/commands/sync, the mobile screen, metadata jobs and YouTube/playlist code exist.
5. M4: financial ledger with integer money, splits, debts, revisions/voids and reconciliation. Backend, the ledger-invariant integration tests (split-sum validation, void/restore revisions, RLS isolation and double-entry balance reconciliation) and a mobile Money screen (accounts, income/expense transactions with void, people) are implemented. Remaining: categories/splits/debt UI, reports, native acceptance and larger-scale property/fuzz testing.
6. M5: search transliteration (cross-script Hinglish↔Devanagari) and later-module coverage, export, deletion pipeline, final web account pages and transactional email are implemented server-side. Remaining: mobile offline transliteration, relevance/latency acceptance and the verified web account-deletion flow.
7. M6: optional text AI, tools/policies, confirmations, citations, memory, quotas and the 300-case evaluation gate.
8. M7: security/load/accessibility testing, legal review, stores and beta rollout.

Each milestone retains the specification's exit criteria. No milestone is waived by this checklist.

## Deliberate limits of this increment

- Auth uses revocable opaque seven-day sessions for the evaluation, not the specified JWT/rotating-refresh design. Email verification, OAuth and password reset remain unavailable. Settings exposes export/deletion scaffolding, but the lifecycle gaps above remain; AI is not implemented.
- The development-preview checkbox is not final legal acceptance. Versioned purpose-specific consents remain required before public signup.
- API authentication endpoints currently live under `/api/auth/*`; product routes use `/api/v1/*`. Domain endpoints accept bearer tokens only; browser domain writes will need CSRF before the full web app.
- `/api/v1/commands` is a shared command endpoint for the initial slice. The full resource endpoint catalogue and generated client are pending. Current client uses the same Zod contracts and validates responses.
- Capture suggests tasks and reviewed dates in a supported English/Hinglish/Hindi subset: today/tomorrow/day-after, weekdays and `next <weekday>`, ISO dates, `in N days`, and now `next week`/`in a week`/`agle hafte`/`अगले हफ्ते`, `this weekend`/`weekend`, and `end of month`/`month end`. Deadline cues (`by`, `due`, `tak`) still route any of these to the deadline. Amounts, expenses, reminders, time-of-day and comprehensive language coverage remain pending.
- Quick Capture creates paragraph notes; Edit opens the bundled Tiptap editor through Expo DOM. Formatting is canonical JSON with server-derived text. Drafts persist after Close or rejected saves; acknowledgement clears only the accepted draft. Unfinished edits can sync as history checkpoints, but cross-device draft merging is unavailable. Images/attachments and low-end Android/older iPhone/Hindi IME/accessibility acceptance remain open; ADR-027 is still proposed.
- History snapshots cover explicit saves/restores and changed-content ten-minute/session-end checkpoints. Checkpoints preserve the published note and backlink relations. Previously loaded history is cached offline; unseen history requires connectivity. Retention applies on snapshot writes. Restore is version-checked and preserves folder, pin/favorite/archive flags and local drafts. See [note editor behavior](note-editor.md).
- Mobile cache tables currently use the Expo SQLite API directly behind a store interface, with additive table creation and defaults when reading older JSON records. Explicit versioned Drizzle SQLite migrations are still required for M1.
- Mobile sync uses foreground polling and exponential backoff/jitter, honors server retry delays, pauses on auth failures and drains new in-flight edits. OS background execution/connectivity triggers, attachment transfer and full v1.1 conflict handling remain pending. See [offline sync behavior](offline-sync.md).
- Field-level last-writer-wins is not implemented; stale task commands return a visible conflict. Completion/conversion of an unsynced capture is disabled until its first acknowledgement.
- Subtasks are one level deep and shown nested under the parent; new subtasks start without a planned date. Priority is 0–4, planned dates and deadlines are separate, and timed deadlines preserve timezone intent. Recurring successors appear after sync, copy at most 100 live subtasks, and cannot contain independently recurring subtasks. See [recurrence behavior and limits](recurrence.md).
- Projects support ordering, colors, archive, task assignment, related notes and related learning resources. Archiving a project does not hide its tasks from Today; assignment to archived projects requires unarchiving. Parent assignment moves subtasks atomically. Upcoming includes today; Completed shows the last 30 calendar days.
- The UI offers Trash for top-level tasks, notes and unfiled inbox captures; task Trash/restore cascades to subtasks on one shared version. Purge is guarded to already-trashed items. A converted inbox item cannot be dismissed because it is preserved as provenance. Folder deletion is permanent and allowed only when no notes (including archived/trashed notes) or subfolders remain.
- Tags are normalized lowercase arrays set atomically with `item.setTags` (up to 20 tags, 30 characters each). Task/note filtering and global server/local search support tags. Per-tag management screens remain pending.
- Incremental pull supports inbox items, notes, tasks, folders and projects. Deletion markers expire from incremental results after 180 days; stale cursors trigger resumable full recovery. Minimal UUID/owner reservations remain for idempotency and reference integrity, and full recovery includes those markers for local erasure. Physical reservation compaction and the 24-month money-history policy remain pending.
- Permanent purge deletes content, note history and matching cached retry payloads while retaining ownership/UUID/version metadata. Mobile sync removes the cached item, draft, history and queued edits on receiving its marker. A permanent deletion takes precedence over unfinished edits. Account-wide deletion and backup erasure remain M5 work.
- Idempotency records are retained indefinitely in this slice, preserving delayed offline retries. Retention/compaction is pending.
- The worker handles metadata sync signals and nightly maintenance (the latter via the dedicated `personalspace_maintenance` role). Search indexing currently runs transactionally with domain commands. Redis watermark loss is harmless because clients pull PostgreSQL directly.
- Reminder delivery now also runs under the privileged background role (`MAINTENANCE_DATABASE_URL`), with migration 0034 granting it the device-token/notification-log access it needs.
- All worker background jobs — maintenance, reminder delivery, transactional email, data export, learning-metadata fetching and account deletion — now run under the privileged background role (`MAINTENANCE_DATABASE_URL`). Migrations 0033–0038 grant each exactly the tables it touches, with permissive maintenance RLS policies; email uses a column-level `SELECT (id, email)` on `auth_user`, and account deletion needs no auth grant because it retains the auth row as a ledger. The sync relay (`personalspace_worker`) remains restricted to outbox metadata. Each job is covered by a Postgres integration test.
- Follow-up: final erasure of the `auth_user`/`auth_account` rows during account deletion (currently retained) remains, and would require a scoped grant on the auth tables.
- Android development installation and initial sign-in/navigation were exercised on the Pixel 7 emulator on 30 September. Native accessibility, low-end-device/editor acceptance, iOS, app-lock/privacy screens, dark theme and store identifiers still require validation. Bundle export is not a native build.
- Production startup is intentionally gated in `packages/config` until account lifecycle and launch requirements are implemented.

## External inputs when needed

Provisioning will require the owner's chosen domain, hosting region/provider, email provider, Google/Apple developer credentials, EAS project and eventual AI provider. No paid services or deployments were created in this increment.

## Task descriptions, estimates, archive and daily notes

Migrations 0014–0015 add task description JSON/schema version/derived text, optional positive estimated minutes, task archive, and note kind/daily date with a partial uniqueness constraint. Commands `task.updateDescription`, `task.setEstimate`, `task.setArchived` and `note.openDaily` use the existing owner-scoped, versioned and idempotent command path. Daily-note open is a serialized get-or-create operation; an existing note is returned without changing its version/content/history. Restoring a trashed daily note checks for date collisions.

Mobile task cards expose Details for the rich description editor and estimates, plus Archive/Unarchive. Archived tasks appear only in the Archived task view; task status stays independent. The shared editor keeps separate drafts by entity ID and clears only an exactly acknowledged description. Today opens the daily note for the local calendar date. Offline creation queues a placeholder until sync; if another device created that date first, acknowledgement replaces the placeholder. Existing daily notes retain the normal offline edit flow. Full new-screen native acceptance remains pending.

## Unified search and reviewed capture dates

Migration 0016 adds an owner-scoped search index with weighted simple/unaccent text vectors and title trigrams. Every content command updates the derived index transactionally, including removals. The authenticated `/api/v1/search` contract supports grouped types, tags, status, project/folder, inclusive UTC creation dates, archive inclusion, limit and offset. Mobile FTS5 is maintained by SQLite triggers and searches local records before merging server results. Incoming search data cannot overwrite pending edits, newer records or purge markers; caching it does not advance the sync cursor. See `search.md` for semantics and open acceptance gates.

Quick capture now exposes an editable Date and secondary Add deadline. A reviewed task suggestion can populate each independently using supported date phrases. The capture command accepts an optional initial task deadline so creation and dates share one transaction and offline mutation. The original text is not rewritten. Ambiguous phrases prompt explicit date review; time-of-day, recurrence and comprehensive language coverage remain pending.

## Reminders increment

Migration 0024 adds the `reminders` table with RLS, ownership FKs, fire-at scheduling index and entity attachment. Commands `reminder.create`, `reminder.update`, `reminder.snooze`, `reminder.dismiss`, `reminder.done`, `reminder.cancel`, `reminder.delete`, `reminder.restore` and `reminder.purge` use the existing owner-scoped, versioned and idempotent command path.

Reminders can be standalone ("drink water at 4") or attached to any existing entity (task, note, etc.) via `entityId`. Time semantics match the specification: floating mode recomputes `fire_at` from the user's timezone; fixed mode stores an absolute instant. Both use compatible disambiguation so DST transitions never silently lose a reminder.

Snooze durations follow the spec: 10 minutes, 1 hour, this evening (18:00 local, or tomorrow 18:00 if past), and tomorrow morning (09:00 local). Snoozing updates `fire_at` and sets status to `snoozed`. Updating a snoozed or fired reminder resets it to `scheduled` with a recomputed `fire_at`.

Reminders are included in incremental sync, search indexing and permanent-purge cleanup. The record schema carries `entityId`, `remindDate`, `remindTime`, `fireAt`, `snoozedUntil` and `lastFiredAt`. Mobile record constructions include the new fields with null defaults.

A mobile Reminders screen (under the new "More" hub) now creates standalone reminders with floating/fixed timezone intent and supports done/snooze/dismiss/delete, consuming the existing command path and optimistic cache. Remaining: local notification scheduling, push notification delivery wiring, device token registration from the app, notification permission flow, and native device acceptance.

## Learning increment

Migration 0025 adds `learning_collections` and `learning_resources` tables with RLS, composite ownership FKs, URL deduplication (SHA-256 hash unique index per user), collection tree support (max depth 3 with cycle detection), and playlist parent/child nesting.

Collections support four commands: `collection.create`, `collection.rename`, `collection.move` and `collection.delete`. Deleting a collection detaches its child resources and subcollections rather than cascading deletion. Resources support eight commands: `resource.save`, `resource.update`, `resource.setStatus`, `resource.setProgress`, `resource.setCollection`, `resource.delete`, `resource.restore` and `resource.purge`.

Ten resource types are supported: `youtube_video`, `youtube_playlist`, `article`, `website`, `documentation`, `course`, `pdf`, `book`, `podcast` and `other`. Six statuses follow the spec: `saved`, `want_to_learn`, `in_progress`, `completed`, `paused` and `archived`. Progress tracking includes percent (0-100), seconds and mode (`auto`/`manual`). Video resources auto-complete at >= 90% progress. First progress update on a `saved` or `want_to_learn` resource auto-transitions status to `in_progress`.

URL deduplication prevents saving the same canonical URL twice per user. Metadata status tracks background fetch state (`pending`/`ok`/`failed`). The record schema carries all learning fields including `collectionId`, `url`, `resourceType`, `author`, `progressPercent`, `thumbnailUrl` and `metadataStatus`.

A mobile Learning screen (under "More") now saves resources (URL/title/type), tracks status and manual progress, files resources into collections, and creates/deletes collections. Remaining: in-app player with auto-progress, richer collection tree UI, and native device acceptance. Safe URL fetching, metadata worker jobs and YouTube integration are implemented.

## Project-related learning resources increment

Migration 0030 extends the `entity_links` relation check with a `related_resource` value and adds a partial `user_id,target_id` index for it, mirroring the `related` relation used for project-related notes. The `project.setResources` command replaces a project's linked resources atomically with owner and version checks, rejecting unavailable or foreign resources (and trashed resources that are not already linked). Projects serialize a `relatedResourceIds` array in sync, search and command responses. Permanently purging a learning resource removes its links and bumps the owning project's version so other devices drop the stale link. The mobile Projects screen adds a "Related resources" picker alongside "Related notes"; it reuses the same offline optimistic enqueue path.

Migration 0031 fixes a latent defect surfaced by the first integration test to create a learning resource: the `search_documents` type check constraint from migration 0016 still only permitted `note`/`task`/`project`/`inbox`, so any later-module record (reminders, learning, money) that the search indexer wrote violated the constraint. The constraint now lists every type `indexSearchRecords` writes.
