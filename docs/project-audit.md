# Project audit — updated 5 October 2026

Source of truth: `PersonalSpace-Specification-v1.2.md`. This audit covers all four applications, nine shared packages, database migrations, infrastructure, CI, tests and implementation documentation. A feature with code is not automatically complete under the specification's definition of done (§69).

## Overall assessment

The current checkout includes reminder, learning and money schemas/commands/sync, mobile screens for those modules, project-related resources, settings/export/deletion screens, metadata/YouTube jobs, notification/email jobs and maintenance/export/deletion workers. Migrations now extend through 0038, including background-role permissions. Recent integration tests cover several of these database paths, but code and passing domain tests do not establish working provider delivery or complete end-user flows.

Attachments have a transfer engine, SQLite queue, private upload API, metadata sync, quota checks, processing/cleanup, scanner integration and private downloads (migrations 0027–0028). Mobile Files adds picker/copy/hash, foreground uploads, progress/retry/removal, other-device metadata and verified download/share. Offline pins, configurable LRU download storage, safe cache clearing, startup orphan reclamation and cleanup of confirmed completed-upload copies are implemented. The editor now includes ID-only inline file labels, searchable insertion and draft-safe native add/open actions. On-demand image previews are implemented in the editor and Files screen. Recent thumbnails download automatically in the foreground within the cache budget. Scanner provisioning, remaining formats and native acceptance stay open. Files remain quarantined unless the configured processor succeeds. See [attachment status](attachments.md).

The repository is a development preview with a substantial PostgreSQL/RLS and offline-sync foundation. It is **not a completed v1.0 application**. Phase 0 and milestone acceptance remain open. Production startup is intentionally gated in `packages/config`.

The main application path is mobile SQLite outbox → validated API commands → domain transaction → PostgreSQL entities, audit and outbox → incremental sync. Workers now also handle attachment processing/cleanup and the newer background modules. The web application remains a landing/legal shell.

## Current operational gaps found in code

These findings were checked against the shared checkout after the newer module commits arrived. Other changes were still in progress; this is not acceptance of that entire checkout.

- Reminder delivery in `packages/domain/src/notifications.ts` creates deduplicated notification-log rows and advances reminder state. Native token registration/local scheduling and actual provider delivery still need end-to-end verification; a logged notification is not proof that a device received it.
- The worker instantiates `ConsoleEmailProvider`. `packages/domain/src/email.ts` currently logs recipient/body content instead of contacting an email provider. Provider wiring, content-safe logging, verification/reset flows and delivery acceptance remain open.
- The account-deletion worker's storage callback in `apps/worker/src/index.ts` currently logs a cleanup event without deleting objects. The auth-user erasure lifecycle is also incomplete. Database row deletion alone does not complete account erasure.
- The export worker can mark an export ready when storage is unavailable. Its CSV branch serializes a map of files as JSON, and its Markdown branch emits JSON. Correct format artifacts, durable storage, expiry/cleanup and the user download flow need acceptance before exports are described as complete.
- Mobile Money has basic account/transaction/people flows; category/split/debt workflows, reports and wider ledger property testing remain. Learning needs player/progress and metadata/provider acceptance. The new module screens still need native validation.
- Formal versioned SQLite migrations, OAuth/recovery/refresh-family work, native capture/widget surfaces, AI and production/release gates remain unfinished. Inline editor file-reference nodes are implemented.

The offline-storage implementation and its verification are recorded in [attachments](attachments.md) and [verification](verification.md). The table below is the earlier notes/tasks coverage baseline; the current inventory and operational findings above supersede its later-module entries.

## Earlier notes/tasks coverage baseline

| Area                                          | Implemented evidence                                                                                                                                                                                                                                            | Remaining work                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace, infrastructure, CI (§39–42, 71–74) | Four apps; shared contracts; Docker PostgreSQL/Redis; separate database roles; checksummed migrations; test/build workflow                                                                                                                                      | Staging/prod, deployment and rollback, backup restore drill, telemetry, load testing, operational runbooks                                                 |
| Authentication/privacy (§8, 57–64)            | Better Auth email/password, Argon2id, revocable bearer sessions, native secure credential storage, ownership/RLS tests                                                                                                                                          | OAuth, verification/reset email, rotating refresh families, step-up auth, versioned consents, lockout/breach checks, data export/deletion lifecycle        |
| Capture/Inbox (§9, 11)                        | Offline text capture; reviewed task/date/deadline suggestions; explicit note/task selection; atomic conversion with provenance; dismiss/restore/purge                                                                                                           | URL/files, complete parser corpus and preferences, reminders/expense destinations, native share capture, widgets, shortcuts                                |
| Today/tasks (§10, 13)                         | Planned date, timed floating/fixed deadlines, fixed/after-completion recurrence with edit scopes, priority/status/subtasks, rich descriptions/drafts, estimates, archive, tags/Trash, projects/related notes, project-related learning resources and task views | Configurable sections and native acceptance                                                                                                                |
| Notes (§12, 52.9)                             | Canonical bounded editor JSON, rich editor, local drafts with linked conflict-copy recovery, daily notes from Today, structured backlinks/Linked from, tags, pin/favorite/archive, Trash, native previews                                                       | Attachments, AI suggestions, editor IME/accessibility/performance acceptance                                                                               |
| Folders (§12.1)                               | New create/rename/move/delete commands, owner FKs/RLS, depth ≤3 and subtree/cycle checks, synced folder records, note filing, mobile folder picker/filter/management                                                                                            | Native interaction/accessibility acceptance; empty-folder deletion is deliberately guarded, including notes in Archive/Trash                               |
| Note history (§12.4)                          | Snapshots at creation/content save/restore plus ten-minute/session-end editing checkpoints, paginated API, cached previews, audited restore, union of latest 50 and last 30 days                                                                                | Native interaction acceptance and cross-device draft merging. Checkpoints preserve published content                                                       |
| Offline/sync (§46, 52.2)                      | Account-scoped SQLite/outbox, idempotency, ordered pages, conflict rollback, permanent-purge markers, stale-response protection, foreground backoff/jitter, Retry-After/auth pause, resumable full recovery and in-flight edit draining                         | Physical reservation compaction, Drizzle SQLite migrations, OS background/connectivity triggers, attachments, richer conflict UX and final ADR-011         |
| Reminders/onboarding (§8, 14, 22, 50)         | Preview account form and basic app empty states                                                                                                                                                                                                                 | Full onboarding/preferences, reminder model, local/server scheduling, snooze, push/device tokens, cancellation and delivery matrix                         |
| Learning (§17, 51.4)                          | No learning domain or screens                                                                                                                                                                                                                                   | Safe URL fetching, metadata jobs, resources, collections, progress/playback and duplicate handling                                                         |
| Money (§18, 45, 65)                           | No financial domain or screens                                                                                                                                                                                                                                  | Integer-money ledger, accounts/categories, splits, debts, revisions/voids, reconciliation, reports, property tests                                         |
| Search/export/deletion (§19–20, 47, 64)       | Global notes/tasks/projects/Inbox search, local FTS5 + PostgreSQL prefix/typo matches, grouped results, filters, pagination; deletion-aware indexes                                                                                                             | Hinglish/Devanagari transliteration, later-module search, relevance/load/native acceptance, archive generation, reauthentication, account deletion/erasure |
| AI/voice (§26–38)                             | No AI provider, tool registry, model orchestration or voice pipeline                                                                                                                                                                                            | Optional AI settings/consents, read/create tools and policies, confirmations, citations, quotas, memory, 300-case evaluation gate; voice belongs to v1.1   |
| Design/mobile/release (§24–25, 52, 66–76)     | Shared colors/basic components; Android development build previously exercised; mobile rich-editor browser checks                                                                                                                                               | Full design system, dark mode, localization, native security/privacy screens, accessibility, device matrix, store preparation, legal/product review        |
| Web (§53)                                     | Landing page and clearly marked draft legal pages                                                                                                                                                                                                               | Verified account-deletion request flow and final public pages; full web app remains v1.1 scope                                                             |

One level of subtasks is the specified v1 requirement (§13.1). Deeper nesting is not an unfinished v1 feature. Separate deadlines and `in_progress`/`cancelled` were already implemented before this audit.

## Defects addressed in this pass

- Permanent purge previously disappeared from the entity stream, leaving other devices' Trash stale. A minimal entity marker now reserves the ID and propagates deletion; migration 0010 reconstructs earlier purges from audit metadata.
- Retry responses retained purged private content. Purge now removes matching response entries while preserving retry hashes, and erases note history through a cascading ownership FK.
- New required cache fields broke older SQLite records and retry responses. Response-schema defaults now upgrade missing fields without discarding content.
- An old acknowledgement could replace newer cached server data. Cache writes now compare versions; persistent local deletion markers also block resurrection after restart.
- Multiple pending edits of one item could overwrite optimistic state. The store now prevents overlapping commands for that item and preserves drafts on conflicts.
- Editor link JSON included an unrecognised nullable `title` attribute, preventing save; checklist styling targeted an outdated DOM attribute; read-only toggling triggered unintended draft writes. These are covered by the new browser suite.
- Cancelled tasks could still display the overdue warning in All Tasks. Warning rendering now uses the same closed-status rule as Today.
- Dismissing a rejected folder/project/subtask creation now removes its abandoned optimistic record.

## Implementation order from here

1. Finish M1: note attachments, native editor/folder/history/project/recurrence acceptance, remaining conflict policy and SQLite migration work. Project-related learning resources, expired-cursor recovery and explicit note draft copies are implemented.
2. Complete identity/account lifecycle and Phase 0 decisions in parallel with M1 where provider-independent work is possible. Keep production gated.
3. M2: onboarding/preferences, deterministic capture parsing, reminders, native share/widget surfaces and delivery testing.
4. M3: learning and safe metadata fetching.
5. M4: money, starting with ledger invariants and property tests before financial UI.
6. M5: search, export and account deletion across database, cache, jobs, files and providers.
7. M6: optional AI through the same domain services, with policies and evaluation gates.
8. M7: security, performance, accessibility, legal review, real-device beta and store launch.

No later milestone is marked complete by the existence of a placeholder UI or an interface. Native emulator interaction is currently deferred at the user's request. Other external gates need chosen providers/accounts/domain, native iOS tooling, human discovery/design/legal review and release acceptance.

## Applying this increment

Run `pnpm db:migrate` before starting this version on another checkout, then update the mobile JavaScript bundle. Migrations 0010–0023 expand purge markers, history, folders, projects, task details, daily notes, search, timed deadlines, project-note links, note references, recurrence and cascade-safe recurrence ownership constraints, retention indexing and recovered-note source links; old migration files are unchanged. Existing notes receive an initial history snapshot. Folders/projects add entity types to the development sync contract, so API and mobile should be updated together.

The implementation session tested migrations in isolated databases, then applied them to the existing local development database. PostgreSQL/Redis, the API and worker are running, and the HTTP → outbox → worker → Redis smoke check passed using a temporary synthetic account. The emulator was not controlled or restarted. Detailed checks are in `verification.md`.

## Task details and daily notes increment

Task descriptions use the same bounded editor JSON and recoverable local drafts as notes. Saving preserves the task title, status and scheduling. Estimates accept positive whole minutes (up to one year) or no estimate. Archive is independent of task status and has its own task view.

Daily notes are keyed by the device-local calendar date when opened from Today. PostgreSQL serializes concurrent opens and enforces one live daily note per account/date. Opening an existing note preserves its content and history. Trash releases the date; restoring an older daily note fails with a clear conflict if another live note owns that date. Mobile replaces an empty local placeholder with the canonical note returned by another device. A new daily note can be queued offline, but must sync before editing; previously synced daily notes can be edited offline.

## Search and capture increment

Search now covers all four implemented searchable types: notes, tasks, projects and Inbox. It searches SQLite first, then merges online results with pending-edit/version/purge protection. Results group by type with filters for tag, status, creation date (UTC), project/folder and archive, and paginated type views. PostgreSQL indexes are updated in the same domain transaction; SQLite triggers cover optimistic edits, rollback, Trash and purge. Migration 0016 backfills existing server content, and cache initialization backfills existing SQLite records once. Native search acceptance and transliteration remain pending; see `search.md`.

Quick capture offers editable planned-date/deadline suggestions for supported English, Hinglish and Hindi phrases. Relative days, weekdays and ISO dates use the device-local calendar date; deadline cues remain separate from planned dates. Ambiguous `kal`/`कल`, conflicting dates, numeric slash dates and repeating phrases ask for review. Original text is retained. This is a deterministic subset, not the complete parser/reminder/expense milestone.

## Timed deadlines and related notes increment

Task Details now saves optional deadline times with floating or fixed timezone intent. Shared timezone calculations distinguish wall-clock times from absolute instants, reject nonexistent fixed times, require a choice for repeated fixed times, and update Today/Upcoming/Overdue for travel and time-of-day. Projects now link and open owned notes, with offline saves and atomic link cleanup when a note is permanently deleted. See [behavior and validation details](deadlines-and-project-notes.md). Native interaction and reminder delivery remain open.

## Structured backlinks increment

Notes now include a `[[` picker and stable-ID inline references, with current titles and a Linked from section derived from account-scoped cached notes. Content save/history restore atomically validate and replace reference relations; owned purged IDs remain readable placeholders without recreating relations. Following a link awaits local draft storage. The browser editor suite checks picker selection, rename display and failed-storage navigation. Native acceptance remains deferred. See [note editor details](note-editor.md).

## Recurrence, checkpoints and retry increment

Task recurrence now includes fixed schedules, after-completion dates, weekdays/month ends, finite series, occurrence/future editing, skip, subtask copying and atomic successor creation. Tests cover ownership, concurrent retries, reopening, count exhaustion, DST and actual offline completion timestamps. See [recurrence](recurrence.md).

Notes queue changed-content checkpoints every ten minutes and on close/back/link navigation, preserving published content and local drafts. Checkpoints appear in version history after sync and are erased by permanent purge. Foreground sync now backs off with jitter, honors Retry-After, pauses on auth failures and drains edits queued during a successful in-flight request. See [editor](note-editor.md) and [sync](offline-sync.md) details. These implementations do not close the native acceptance or later milestone gates.

## Recovery and conflicting drafts increment

Incremental deletion markers now expire after 180 days. HTTP 410 triggers an account-scoped full refresh that resumes across failures/restarts before replaying queued mutations. Full mode includes old reserved purge markers so stale local private data is erased. Outbox keys, unrelated drafts and optimistic captures remain intact. Server UUID reservations are retained; physical compaction remains open.

Conflicting note drafts can be saved as separate rich notes without overwriting the source. Copies retain a source link, initial history and searchable content; the original local draft clears only after acknowledgement of an exact match. Source Trash/purge and ownership guards prevent recovery from unavailable or foreign notes. Native acceptance, automatic merging and field-level conflict policy remain open.
