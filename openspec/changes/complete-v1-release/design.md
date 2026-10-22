# Design

## Context

See `proposal.md` for motivation and scope. This is a staged completion program, not one deployable patch. The existing architecture is Expo mobile with account-scoped SQLite/outbox, Fastify/BetterAuth, PostgreSQL with RLS, BullMQ/Redis workers, private object storage and a Next.js web shell. The sixteen capability deltas establish acceptance contracts for both missing behavior and preservation of existing features.

Observed source anchors from the exploration:

| Area                | Current evidence                                                                                                                                            | Design consequence                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Background delivery | `apps/worker/src/index.ts` registers metadata/notification/email repeats after the active loop; `packages/domain/src/email.ts` lacks durable claims/retries | Fix registration and delivery state before depending on email or push             |
| Notifications       | `packages/domain/src/notifications.ts` inserts logs without transport; mobile scheduling can report coverage beyond failures                                | Separate durable intent, provider submission and confirmed local coverage         |
| Money               | `packages/domain/src/money.ts` initializes but does not maintain cached balances; `MoneyScreen.tsx` reads them                                              | Repair the transactional source of displayed balances before expanding forms      |
| Learning            | `metadata.ts` checks only the initial host; `youtube.ts` writes imported resources outside the normal command flow                                          | Introduce a constrained fetch boundary and owner-scoped import mutations          |
| Mobile              | `App.tsx` is primarily a task/notes shell; preference choices are persisted without full consumers                                                          | Build shared preference/session providers and compose complete feature screens    |
| Lifecycle           | Exports, erasure and retention have recent durable implementations through migration 0043                                                                   | Extend these flows; retain their fencing, cleanup manifests and replay guarantees |
| AI                  | No assistant implementation or `packages/ai` currently exists                                                                                               | Build a domain-client orchestration boundary, not a second data-access path       |
| Release             | CI checks exist; `packages/config/src/index.ts` explicitly blocks production                                                                                | Retain the guard until evidence-driven release activation                         |

The most recent recorded automated results are 177 unit and 99 integration tests on 9 October 2026, not fresh verification of this proposal. Existing unrelated edits in API/mobile auth, API CORS and generated web types must remain outside planning and feature commits unless deliberately reconciled later.

## Goals / Non-Goals

**Goals:**

- Deliver small coherent increments whose acceptance maps to specs, with explicit dependencies and separate external gates.
- Reuse the current domain commands, account mutation serialization, entity versions, audit/outbox and shared validation contracts.
- Make user-visible success reflect durable local or confirmed remote work, with the difference displayed.
- Keep provider failures and unsupported OS behavior recoverable and observable.

**Non-Goals:**

- Rewriting the framework stack, replacing the working editor, introducing CRDT sync or implementing v1.1 features.
- Treating a checked task, successful bundle or mocked test as physical-device or launch approval.
- Publishing or deploying this proposal. This turn changes planning artifacts only.

## Decisions

### 1. Deliver a dependency-ordered program with bounded commits

Use one umbrella change because the request covers the audited remainder, but organize tasks as independent feature increments. Complete each implementation/check/documentation/commit-push group before proceeding; leave blocked external acceptance unchecked and continue independent code work. Do not archive the umbrella until all required gates have evidence.

The execution dependency graph is:

```text
01 schedules -> 02 email -> 05 identity -> 06 sessions/privacy
03 ledger correctness -> 07 money workflows -> 10 Today -> 17 AI tools
04 safe fetch -> 08 Learning -----------------> 17 AI tools
09 preferences -> 10 Today / 11 capture / 14 native capture
12 sync/files -> 13 notes/tasks/search -> 14 native capture
01 + 05 + 09 -> 15 notification delivery
02 + 05 + 12 -> 16 export/erasure completion
03 + 04 + 05 + 07 + 08 + 13 + 16 -> 17-19 AI
all feature increments -> 20 operations -> 21 external acceptance -> 22 release decision
```

Operations instrumentation can be implemented earlier when needed. External-provider setup can progress alongside implementation, but cannot be recorded as successful integration until exercised. An alternative single large implementation would make regression attribution and safe delivery impractical.

### 2. Separate durable job intent from queue transport and provider outcomes

Keep PostgreSQL as the recovery source and Redis as execution transport. Register repeat schedules inside normal startup/retry progression with stable schedule identities and independent failure handling. Keep deletion and maintenance scheduling already repaired intact.

Add delivery state/attempt metadata through additive migrations: bounded claim lease, attempt count, next-attempt time, stable logical/provider idempotency key, sanitized failure category, provider reference and terminal outcome. Claim atomically, fence stale completions with the claim identity, and recover expired claims. Queue jobs carry references rather than message bodies. Replay after Redis loss scans durable pending intent in bounded batches.

Keep the existing Resend adapter as the initial email integration, adding timeout/idempotency/error normalization. A development sink must explicitly return preview status and omit private message content from normal logs. Production readiness fails when a required delivery adapter is absent. Transactional enqueue failures cannot be swallowed by auth hooks.

Provider acceptance does not prove user receipt. Email and push retain their respective receipt capabilities and unknown outcomes; do not promise universal exactly-once display. The alternative of marking logs sent before transport or retrying without stable identity is rejected.

### 3. Make ledger effects transactional and shared

Extract a pure integer-money effects calculator governed by section 45, including category versus receivable shares, transfer legs, adjustments, lending/borrowing and repayments. Use it for mutation validation, balance/debt effects, reconciliation and report fixtures. Derive edit/void/restore differences from before/after states, rather than layering ad hoc increments.

Under the account mutation lock, validate owner/currency/split constraints, write the transaction/revision, update every affected finance account/debt, allocate their entity versions and publish audit/sync events in the same transaction. Return all affected records to the optimistic client. Replayed mutation IDs return the previous outcome before any effects are reapplied. Validate retained splits when an amount changes.

Backfill historical caches with a separately audited, resumable repair that recomputes canonical balances and emits account updates. Keep routine maintenance report-only. This avoids hiding ledger bugs through nightly overwrites. Property tests compare random valid mutation sequences against a simple independent reference ledger, not against the same production helper.

### 4. Use a dedicated constrained external-content fetcher

Replace hostname-only filtering with a shared server-side fetch boundary: scheme/port validation, complete address classification, connection binding to validated DNS results, bounded redirects with validation at every hop, response/time limits and response-body cancellation. Never attach user authentication headers to fetched content. Keep the ordinary metadata parser downstream of this boundary; future article/PDF summaries use it too.

Provider APIs use known destinations and their own quota/timeouts. Playlist children enter through owner-scoped import/domain operations so reservations, versions, audit and sync remain consistent; persist pagination progress and stable source identities. Fetch failures leave user-edited titles and saved URLs intact. A URL regex or redirect check alone cannot prevent address changes during connection, so those alternatives are insufficient.

### 5. Extend identity through a compatibility boundary

Keep BetterAuth for credential/OAuth verification, subject to its installed-version capabilities. Add an explicit mobile credential/session service for the required rotating refresh families if existing plugins do not provide the complete specified behavior. Store token hashes and family/session state server-side; enforce 15-minute access, 30-day sliding and 90-day absolute refresh lifetimes, reuse revocation, rate limits and audit. Treat concurrent refresh as a client single-flight operation and test crash/retry behavior without weakening reuse detection.

Expose typed verification, recent-authentication and session-revocation contracts. Step-up grants are purpose/session-bound and short-lived; changing identity invalidates them. Apply verification and recent-auth checks server-side for export/deletion/AI and account changes. Record versioned consent decisions independently of transient UI state.

Add app-link and web-fallback completion pages for verification/reset. Validate callback state and redirect allowlists; do not place credentials in analytics or crash data. Public deletion requests verify possession through the specified email-link journey and never delete from an email address alone. Existing password-confirmed deletion remains supported during transition. Mobile token cutover uses an explicit upgrade/relogin path that preserves queued local work. Do not silently treat existing bearer session tokens as already rotating JWT families.

### 6. Compose user workflows around shared state and validation

Introduce account-scoped preference and session/privacy providers, then use shared date/currency formatting, input parsing and accessible form components. Theme must reach native screens, dialogs and the DOM editor. Launch UI remains English with Indian English conventions; strings are externalized, while capture/search/AI input supports English, Hinglish and Devanagari. Hindi UI translation is not added to v1.0 by this proposal.

Compose Today from local selectors for tasks/reminders/learning/ledger aggregates. Preserve explicit overdue rollover. Complete Money forms for all transaction types and splits, and Learning collection selection/editing and media resume. Use provider-compliant embedded playback for supported media with an external-open/manual-progress fallback. Persist automatic progress at bounded intervals and lifecycle boundaries, applying the specified completion threshold.

Every changed screen needs empty/loading/offline/pending/conflict/error states, retained form data, announced validation, predictable focus and disabled duplicate submit. Refactor oversized components only where necessary to isolate these workflows; do not replace stable editor/task logic for visual consistency alone. Navigation returns to the previous context after a modal, notification or successful unlock.

App lock uses supported native biometric APIs and a protected PIN verifier with retry/backoff, background timeout and switcher obscuring. No plaintext PIN is stored. Notification/share/deep-link handlers wait for the correct authenticated/unlocked account before revealing content. Recovery requires real account authentication, not an unverified local toggle.

### 7. Preserve offline protocol and private-file guarantees

Keep existing SQLite/outbox and server mutation semantics. Add connectivity/lifecycle scheduling with OS-supported background work as best effort; foreground execution remains the reliable recovery path. Cache upgrade fixtures include queued commands, drafts, expired cursors and file manifests. Unsupported downgrade presents a recoverable incompatibility state without wiping data.

Continue private attachment grants, processing/scanning, integrity verification, pin-aware LRU and durable cleanup. Test native picker/share lifecycle separately from filesystem-adapter tests. Queue late callbacks against the initiating account/session generation. Full resync must merge server state around local pending intent and retained deletion reservations, not replace the entire local database indiscriminately.

Complete search transliteration and module parity with a shared relevance corpus, explicit supported local/server differences and deletion-aware index updates. Test original display text and account changes while queries are in flight. Semantic search remains excluded.

### 8. Reconcile notification schedules with explicit delivery coverage

Normalize stored device tokens with platform and transport metadata; never guess whether a native token is an Expo token. Use a push adapter boundary with an initial Expo transport and explicit handling/re-registration for legacy/native registrations; provision native transport adapters if required by the release configuration. A registration is deliverable only when its selected adapter can handle it.

Replace cancel-all/maximum-success watermark behavior with serialized reconciliation of stable reminder occurrence IDs and successful per-occurrence coverage. If the compact watermark is retained for older clients, it must represent a proven complete prefix; known holes remain eligible for server fallback. Schedule updates and receipts must not race with sign-out or erasure. Dedupe per device/occurrence and reconcile invalid tokens.

Derive task-due, debt-due and export-ready intents from domain state/events. Apply notification toggles, quiet hours, daily caps and privacy previews before transport. Versioned payloads let older clients ignore unsupported actions safely. Validate local cancellation failures, holes, travel/DST, device token rotation and provider-accepted-but-receipt-pending cases.

### 9. Extend export and erasure inventories before adding AI data

Create a reviewed data inventory mapping each user-owned table/object class to export, retention and deletion policies. Include relationships, preferences, relevant histories and original files; never export password hashes, refresh credentials or provider secrets. Exports use a bounded, documented snapshot strategy, streaming output and attempt manifests registered before object writes. If files are unavailable, report incomplete/retrying rather than a complete export. Apply section 60 envelope encryption to archive keys and scoped short-lived downloads.

Extend current deletion fencing/claims with paginated progress and external-provider actions. Keep late-upload sweeps, versioned objects and multipart inventory. Maintain an erasure ledger outside restorable application snapshots so restore procedures can reapply deletion obligations before traffic resumes. Publish the actual backup-expiry policy; do not claim immediate backup erasure. Add AI tables/objects to this inventory when introduced, with no release window where new personal data escapes export/erasure.

### 10. Build AI as policy-controlled orchestration over domain services

Create `packages/ai` for provider adapters, versioned prompts, strict tool registry, entity resolution, context budgets, policy and evaluation fixtures. The API owns authenticated SSE and confirmation endpoints; tools call the same domain commands as ordinary clients. Model output cannot choose identity or bypass RLS. No direct model database access.

Persist conversations, turns, tool attempts, pending actions and approved memories under owner policies. Encrypt message/memory content using per-record envelope keys; redact logs and enforce retention. Scope idempotency to stable conversation/turn/tool identities. Persist immutable confirmation arguments and record versions with 10-minute expiry. Confirmation is a separate user endpoint; model text cannot invoke it. Encode all section 29 rules, including E1/E2/E3 exceptions, in one deterministic policy module and mirror them in evaluation cases.

Only allow v1.0 tools; add result cards with assumptions, sources, Undo and verified outcomes. Include note summarize/extract/rewrite proposals and article/PDF summaries without granting unsupported arbitrary note-update or bulk tools. User acceptance saves generated edits through the ordinary editor/domain flow. Failover is allowed for transient read/generation failures, never by replaying an uncertain write through a second provider.

Select provider/model configuration through the specified tool-calling and English/Hinglish evaluation spike. The adapter and evaluation design do not depend on the selected vendor. CI deterministic policy/tool tests run without credentials; credentialed evaluations are a separate gate with at least 300 cases and the exact section 37 thresholds. AI stays behind flags until those gates pass. This avoids coupling correctness to a prompt's willingness to follow policy.

### 11. Tie release activation to an evidence register

Extend existing CI and runbooks incrementally. Use immutable image/build revisions, separate environments, additive migration checks, staging smoke tests and explicit production promotion. Keep staging/deployment jobs disabled until their environment bindings and secrets are configured. Health rollback reverts application artifacts to a schema-compatible revision, not destructive migrations.

Add content-minimized metrics for queues, delivery, cleanup, sync, ledger drift and AI cost, with actionable alerts. Verify encryption, key rotation, backup restoration, deletion replay and incident procedures. Maintain an acceptance register mapping sections 68-70 to automated and physical results, revision, platform, date and unresolved failures. Record pending prerequisites rather than substituting mocks.

Do not remove the production guard merely because implementation tasks are checked. Release activation requires documented provider, native, security, legal/store and beta evidence; deployment/store submission remains a separate explicit promotion action.

## Risks / Trade-offs

- **Large scope obscures progress** → Use the ordered task groups, individual commit/push checkpoints and capability evidence; leave external gates visible.
- **Provider accepts a request before a crash** → Stable provider idempotency where available, durable attempts, receipts and honest unknown states; avoid a false exactly-once guarantee.
- **Existing cached balances are wrong** → Canonical reconciliation fixtures and audited versioned repair before relying on reports.
- **Auth cutover strands offline work** → Preserve account IDs/local queues; test expiry, upgrade and forced relogin without cache deletion.
- **Background OS execution is limited** → Best-effort scheduling plus durable foreground recovery and real-device measurement.
- **Library/provider capabilities differ from expectations** → Inspect installed auth/native/queue docs during implementation; record adapter-specific ADRs and run credentialed acceptance before enablement.
- **Long exports compete with live writes** → Bounded snapshot/streaming strategy, cancellation and resource-load tests; document its consistency boundary.
- **Privacy obligations extend beyond live tables** → Versioned inventory, external processor records and restore-time erasure replay.

## Migration Plan

1. Before each persistence increment, confirm the applied development/staging schema without changing the user's running services. Earlier migrations 0041-0043 were tested in isolation; their presence on a running database must not be assumed.
2. Allocate the next unused forward migration at implementation time. Add columns/tables/indexes and least-privilege RLS/worker grants; use expand/backfill/contract, not destructive resets. Cover new owner tables in erasure/export inventories immediately.
3. Run fresh-schema and upgrade-from-supported-schema integration fixtures using restricted roles. Backfills must be restartable, auditable and bounded; migrations cannot silently resend historical messages or modify canonical money history.
4. Deploy compatible server contracts before mobile clients consume them. Retain old payload readers during the supported overlap and test legacy token/device registrations. Upgrade local caches transactionally with real previous-version fixtures.
5. Exercise new jobs and provider adapters against isolated synthetic data, then configured staging. Roll out via flags and verify metrics; a flag disable pauses new work while preserving durable pending state.
6. Roll back application artifacts only to a revision compatible with the expanded schema. Use forward fixes for data migrations; retain attempt/audit/manifests until recovery obligations are met.
7. After all acceptance evidence is complete, review production activation and release promotion. Do not operate the user's current emulator without new authorization.

## Open Questions

These bind deployment parameters without changing the behavior or implementation breakdown:

- Which provisioned staging host, domains, signing identities and secret-manager references will be supplied for release acceptance?
- Which physical Android/iOS devices and release reviewers are available for the required matrix?
- Which AI provider/model combination passes the planned evaluation spike within the configured budget? The adapter, tool policy and acceptance thresholds remain fixed.
