# Implementation status

## Current increment: development foundation + capture path

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
- [x] Rich-text note editing: headings, bold/italic, lists, checklists, quotes, links, code, undo/redo; native note previews and account-scoped SQLite drafts.
- [x] Shared versioned note-document schema, bounded input validation, server-derived text, formatted JSON in sync, and protection against legacy plain-text edits flattening rich notes.
- [x] Account-scoped durable SQLite cache/outbox, coalesced replay, incremental pull pages on version boundaries.
- [x] Worker publishes deduplicated sync signal jobs and maintains a monotonic Redis watermark.
- [x] Web landing page and explicitly marked privacy/terms drafts.
- [x] Unit and real-PostgreSQL integration test suites.

These checks mean code exists. Validation results are recorded separately in `docs/verification.md`; Phase 0 is **not** complete.

## Phase 0 exit gaps

- [ ] Discovery interviews and timed prototype tests with the specification's decision rules.
- [ ] Owner decisions: team, budget, provider accounts, domain, final product identifiers.
- [ ] Google/Apple OAuth; verification/reset email; verified app/universal links.
- [ ] Auth library evaluation and final ADR-013: short-lived mobile access tokens, rotating refresh families/reuse detection, re-auth, consent version/history, breach check, account lockout.
- [ ] Sync comparison spike against PowerSync and final ADR-011.
- [ ] Mobile rich-text editor spike with low-end Android, Hindi IME and accessibility measurements (ADR-027).
- [ ] Native share-extension/widget proof on Android and iOS; mobile end-to-end test harness.
- [ ] Approved onboarding/Figma flows and design system accessibility review.
- [ ] Staging/prod provisioning, secrets, automated deploy, rollback, instrumentation and backup drill.
- [ ] AI provider/Hinglish evaluation and STT spike.

## Next implementation increments

1. Finish the Phase 0 identity/account lifecycle and native build gates.
2. M1: note editing/deletion/Trash, initial rich-text editor and drafts, task rescheduling, one-level subtasks, task Trash, and item tags landed; still pending are editor device acceptance (ADR-027), folders, attachments, backlinks/version history; projects, deeper subtask nesting, separate deadlines and recurrence.
3. M2: complete onboarding, richer deterministic parsing, widgets/share capture, reminders and device delivery matrix.
4. M3: learning library, safe URL fetching, metadata jobs, playlists and progress.
5. M4: financial ledger with integer money, splits, debts, revisions/voids and reconciliation property tests.
6. M5: search, export, deletion pipeline, final web account pages and transactional email.
7. M6: optional text AI, tools/policies, confirmations, citations, memory, quotas and the 300-case evaluation gate.
8. M7: security/load/accessibility testing, legal review, stores and beta rollout.

Each milestone retains the specification's exit criteria. No milestone is waived by this checklist.

## Deliberate limits of this increment

- Auth uses revocable opaque seven-day sessions for the evaluation, not the specified JWT/rotating-refresh design. Email verification, OAuth, password reset and account deletion are unavailable. AI/export are not exposed.
- The development-preview checkbox is not final legal acceptance. Versioned purpose-specific consents remain required before public signup.
- API authentication endpoints currently live under `/api/auth/*`; product routes use `/api/v1/*`. Domain endpoints accept bearer tokens only; browser domain writes will need CSRF before the full web app.
- `/api/v1/commands` is a shared command endpoint for the initial slice. The full resource endpoint catalogue and generated client are pending. Current client uses the same Zod contracts and validates responses.
- The initial parser only suggests simple tasks. It does not yet parse Hinglish amounts, dates, expenses or reminders.
- Quick Capture creates paragraph notes; Edit opens the bundled Tiptap editor through Expo DOM. Formatting is stored as canonical JSON, with plain text derived on the server. Drafts persist locally after Close or a rejected save; successful sync clears only the acknowledged draft. Drafts are not themselves synced between devices. Images/attachments, backlinks, note history and the low-end Android/older iPhone/Hindi IME/accessibility acceptance gates remain open; ADR-027 is still proposed.
- Mobile cache tables currently use the Expo SQLite API directly behind a store interface; shared Drizzle SQLite schema/migrations are still required for M1. Database initialization is version 1 only.
- Mobile retries every 30 seconds while foregrounded and on resume/manual refresh. Exponential backoff, background connectivity triggers, attachments and full v1.1 conflict handling remain pending.
- Field-level last-writer-wins is not implemented; stale task commands return a visible conflict. Completion/conversion of an unsynced capture is disabled until its first acknowledgement.
- Subtasks are one level deep and share the task table; a subtask carries no planned date and is shown nested under its parent. Rescheduling and the deadline control expose quick Today/Tomorrow/clear actions rather than a full date picker. Priority is set from a 0–4 selector. `due_time`, `time_mode`, extended statuses (`in_progress`/`cancelled`), projects, and recurrence are not modelled yet.
- Only top-level tasks, notes, and unfiled inbox captures can be trashed; trashing a task cascades its subtasks to Trash on one shared version, and restore brings them back together. Subtasks themselves are managed through their parent (complete/reopen only) rather than trashed individually. Purge, for every type, is guarded to already-trashed items and does not yet emit a cross-device tombstone. A converted inbox item cannot be dismissed because it is preserved as provenance.
- Tags are stored as a normalized lowercase array on the entity row and set atomically with `item.setTags` (up to 20 tags, 30 characters each). Filtering is client-side over synced records; server-side tag search, folders, and per-tag management screens are not built yet. A GIN index is in place for future server search.
- Incremental pull supports the current three entity types; it is not the full specification's sync protocol. No deletion/tombstone expiry or 24-month history retention exists yet.
- Note soft-delete (Trash) and restore propagate to every device through the version stream. Permanent purge is only offered on an already-trashed note and removes the row on the server, but it does not yet emit a cross-device tombstone: another device that already synced the soft-delete keeps the note in its own Trash until a full resync. Full tombstone propagation is part of the M5 deletion pipeline.
- Idempotency records are retained indefinitely in this slice, preserving delayed offline retries. Retention/compaction is pending.
- The worker only handles metadata sync signals. Reminders, search indexing, notification, email and other domain workers remain pending. Redis watermark loss is harmless because clients pull PostgreSQL directly.
- Android development installation and initial sign-in/navigation were exercised on the Pixel 7 emulator on 30 September. Native accessibility, low-end-device/editor acceptance, iOS, app-lock/privacy screens, dark theme and store identifiers still require validation. Bundle export is not a native build.
- Production startup is intentionally gated in `packages/config` until account lifecycle and launch requirements are implemented.

## External inputs when needed

Provisioning will require the owner's chosen domain, hosting region/provider, email provider, Google/Apple developer credentials, EAS project and eventual AI provider. No paid services or deployments were created in this increment.
