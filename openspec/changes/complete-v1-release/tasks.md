# Tasks

This checklist tracks the remaining v1.0 program, not work completed by creating the proposal. All boxes start unchecked. Existing behavior needs preservation/acceptance rather than wholesale replacement. Follow the dependency graph in `design.md`; independent groups can progress while external gates remain pending.

For each code increment, run its targeted tests, affected type/lint checks and relevant build before committing. Changes to API/data contracts also require restricted-role integration checks and documented contracts; native changes require bundles plus separately recorded device acceptance. Update audit/verification evidence with exact commands/results and limitations. Stage only the increment, keep unrelated edits and secrets out, push without force, and verify the remote branch contains the commit. The delivery tasks below include these checks. Do not operate the user's current emulator without new authorization.

## 1. Background schedule registration

Capability: `background-delivery`. No feature dependencies.

- [x] 1.1 Move metadata, notification and email schedule registration into active startup/retry progression with stable identities; verify an empty Redis fixture obtains every required schedule while the worker remains running.
- [x] 1.2 Isolate registration failures and recover after queue reconnect; verify duplicate worker startup, unrelated existing schedules and Redis outage/recovery do not lose or duplicate logical schedules.
- [x] 1.3 Preserve deletion/maintenance behavior and shutdown cleanup; run worker schedule integration tests and affected build/type/lint checks, update the maintenance runbook and verification evidence, then commit/push and verify the remote commit.

## 2. Durable transactional email

Capability: `background-delivery`. Depends on group 1.

- [x] 2.1 Add forward migration and restricted-role permissions for delivery attempts, lease ownership, retry timing and sanitized outcomes; verify fresh/upgrade migrations and denial of unrelated account/auth access.
- [x] 2.2 Implement atomic email claims, stale-claim fencing, expired-lease recovery and bounded backoff; verify competing workers and crashes before/after provider submission with stable message identity.
- [x] 2.3 Add Resend timeout/idempotency/error normalization and explicit preview/unavailable outcomes; verify contract fixtures for acceptance, timeout, throttling, permanent failure and missing configuration without raw content logs.
- [ ] 2.4 Make required auth/account/export email enqueue durable and visible on failure; verify rollback/recoverable responses when the enqueue path fails instead of swallowing errors.
- [x] 2.4a Implement the approved completion-only outbox with atomic pre-erasure capture, restricted access, immutable 24-hour expiry, completion gating and removal on terminal outcomes; verify recovery cannot recreate retained recipients and that ordinary erasure fencing remains intact.
- [ ] 2.5 Complete all v1.0 email templates and safe link/expiry rendering; verify template fixtures, accessible HTML/plain text and redaction of tokens/recipients in operational errors.
- [ ] 2.6 Run email/worker integration checks, update delivery/provider setup documentation and audit evidence, then commit/push the tested increment and verify the remote commit; leave real-provider acceptance to group 21.

## 3. Ledger correctness and historical balances

Capability: `money-ledger`. No feature dependencies.

- [ ] 3.1 Implement canonical integer effects for each section 45 transaction/split/debt operation; verify fixed fixtures and property-based tests against an independent reference ledger.
- [ ] 3.2 Integrate create/edit/void/restore with atomic balance/debt updates, entity versions and audit/sync events; verify replay, concurrent writes, partial failure rollback and foreign references in PostgreSQL integration tests.
- [ ] 3.3 Validate retained splits on amount edits and overpayment confirmation rules; verify mismatched totals, unsupported currencies, negative/overflow amounts and invalid debt transitions fail atomically.
- [ ] 3.4 Add bounded audited historical cache repair and drift alert records while keeping maintenance report-only; verify repair restart/idempotency and client-visible balance versions without new financial transactions.
- [ ] 3.5 Reconcile reports/CSV fixtures against ledger totals, run money integration/property checks, document semantics and repair procedures, then commit/push and verify the remote commit.

## 4. Safe external-content fetching

Capability: `learning-library`. No feature dependencies.

- [ ] 4.1 Implement address classification and connection-bound DNS validation with per-hop redirect checks; verify IPv4/IPv6, mapped addresses, alternate host encodings, private destinations and DNS-change fixtures cannot reach forbidden targets.
- [ ] 4.2 Enforce the specification's redirect/time/byte/content limits and stream cancellation; verify oversized, slow, malformed and redirect-loop responses terminate without leaking credentials or losing saved resources.
- [ ] 4.3 Route metadata through the constrained fetch boundary and preserve user-edited fields on failure/retry; verify malicious URL and successful metadata fixtures plus account-isolated update/sync behavior.
- [ ] 4.4 Run fetch/domain checks, document the threat boundary and retry/error states, update the audit, then commit/push and verify the remote commit.

## 5. Recovery links and identity assurance

Capability: `identity-access`. Depends on group 2.

- [ ] 5.1 Implement typed verified-email and purpose-bound recent-auth checks for sensitive endpoints; verify direct API bypass attempts, foreign sessions, expired grants and disabled/unverified AI requests produce no side effects.
- [ ] 5.2 Complete password reset with hashed single-use 30-minute tokens and session revocation; verify token reuse, expiry, concurrent consumption, password policy and non-enumerating responses.
- [ ] 5.3 Add mobile verification/reset completion and accessible web fallback pages; verify valid/expired/tampered links, allowlisted return targets, retained form errors and no token leakage in browser tests.
- [ ] 5.4 Complete Google/Apple callback validation and authenticated native return handling; verify state mismatch, cancellation, repeat callback and account-switch fixtures without replacing another account's queued work.
- [ ] 5.5 Add verified public deletion-request email-link completion while retaining the existing authenticated path; verify an email address alone cannot authorize deletion and expired/replayed links are rejected.
- [ ] 5.6 Run auth/API/web checks, document callback setup and upgrade compatibility, update evidence, then commit/push and verify the remote commit; keep live OAuth/domain acceptance separate in group 21.

## 6. Session lifecycle and account controls

Capability: `identity-access`. Depends on group 5.

- [ ] 6.1 Record the installed-auth compatibility ADR and add refresh-family/session persistence with RLS/erasure coverage; verify migration fixtures preserve existing account identities and expose no token hashes to clients.
- [ ] 6.2 Implement access expiry, refresh rotation, reuse-family revocation and mobile single-flight refresh; verify 15-minute/30-day/90-day boundaries, racing refresh, crash/retry and secure-storage behavior.
- [ ] 6.3 Implement session/device listing and revocation, profile/password/email/sign-in-method changes and step-up enforcement; verify cross-account denial, revocation effects and safe last-sign-in-method handling.
- [ ] 6.4 Add versioned consent records and consent-management controls; verify optional consent withdrawal, audit history and export/erasure inclusion without changing mandatory-account eligibility rules.
- [ ] 6.5 Complete breach checks and progressive abuse controls with safe outage behavior; verify generic auth responses, rate limiting and no credential content in diagnostics.
- [ ] 6.6 Test the old-client token upgrade/relogin path with offline pending work, update identity runbooks and evidence, then commit/push and verify the remote commit.

## 7. Complete Money workflows

Capability: `money-ledger`. Depends on group 3.

- [ ] 7.1 Complete account/category/person create/edit/archive controls and localized integer amount input; verify ownership, nesting limits, pending state and exact parse/display round trips in form/domain tests.
- [ ] 7.2 Add transfer and adjustment forms using canonical effects and explicit affected-account previews; verify both balances, same-account rejection, retry and void/restore behavior end to end in integration fixtures.
- [ ] 7.3 Add lending/borrowing/repayment and debt status workflows; verify partial repayment, permitted overpayment confirmation and debt outstanding after edit/void/restore.
- [ ] 7.4 Add multiple category/person splits and shared-expense previews; verify the section 68 shared-expense example, exact split totals and offline rejection/correction without duplicate optimistic effects.
- [ ] 7.5 Add transaction detail/revision/edit/void/restore screens and complete monthly/category/person reports; verify totals match canonical fixtures and retain edits after recoverable failures.
- [ ] 7.6 Run money UI/domain/integration checks and mobile bundles, document workflows/limitations and native acceptance cases, then commit/push and verify the remote commit.

## 8. Complete Learning workflows

Capability: `learning-library`. Depends on group 4.

- [ ] 8.1 Complete collection/resource rename, move, selection, removal and duplicate-review controls; verify a chosen non-first collection, stale edits, foreign references and offline replay in screen/domain tests.
- [ ] 8.2 Add bounded YouTube provider requests and resumable playlist pagination through versioned owner-scoped domain imports; verify quota failures, repeated pages, duplicate children and mobile sync visibility.
- [ ] 8.3 Add supported in-app playback with position persistence and resume; verify progress checkpoints, the specified completion threshold and manual/external fallback when embedding or network access fails.
- [ ] 8.4 Run Learning domain/UI/provider-fixture checks and mobile bundles, document playback/provider limitations and acceptance cases, then commit/push and verify the remote commit.

## 9. Applied preferences, privacy and shared mobile UX

Capability: `mobile-experience`. App-lock disabling depends on group 5; session controls depend on group 6.

- [ ] 9.1 Add account-scoped preference consumption across theme/text size/capture/week/time/currency/notification defaults; verify changes affect the relevant UI immediately and after restart/account switch.
- [ ] 9.2 Externalize launch English strings and unify locale-aware amount/date formatting; verify en-IN formatting, non-IN currency decimal precision and timezone boundaries without changing persisted values.
- [ ] 9.3 Apply accessible light/dark/system themes to screens, dialogs and editor; verify contrast/text scaling, keyboard reachability, focus return and error announcements with appropriate component/browser checks.
- [ ] 9.4 Add biometric/PIN lock, timeout, secure fallback and switcher obscuring; verify locked deep-link/notification entry, cancelled unlock, repeated PIN failures and step-up enforcement through native-adapter tests.
- [ ] 9.5 Standardize loading/empty/offline/pending/conflict/error and retained-form states in touched screens; verify duplicate submission prevention and recoverable failures in representative workflows.
- [ ] 9.6 Run affected UI/type/lint/bundle checks, document preference/privacy behavior and pending TalkBack/VoiceOver acceptance, then commit/push and verify the remote commit.

## 10. Complete Today overview

Capability: `daily-overview`. Depends on groups 3, 8 and 9; final notification behavior integrates with group 15.

- [ ] 10.1 Compose cache-first task, reminder, learning and money sections with empty-section collapse and saved ordering; verify representative offline datasets and account-switch isolation.
- [ ] 10.2 Add reviewed overdue rollover and section navigation preserving planning/deadline semantics; verify midnight/timezone changes, stale-version feedback and no automatic date movement.
- [ ] 10.3 Reconcile optimistic daily/monthly money and learning values with confirmed versions; verify no double counting after replay and canonical exclusion of transfer/void effects.
- [ ] 10.4 Run Today selector/UI checks and mobile bundles, document daily behavior and cold-start measurement cases, then commit/push and verify the remote commit.

## 11. Onboarding, capture and Inbox triage

Capability: `capture-inbox`. Depends on groups 7, 8 and 9.

- [ ] 11.1 Add guided first capture, optional setup and a resumable checklist with contextual permissions; verify skipping/denying optional steps still permits a durable first offline capture.
- [ ] 11.2 Expand deterministic parser fixtures for English/Hinglish/Devanagari amounts, URLs and dates using section 31 examples; verify ambiguous defaults produce explicit choices rather than silent writes.
- [ ] 11.3 Add expense, learning and reminder capture destinations with resolved-field previews; verify offline save/replay, missing account/time fallback and retained input after server rejection.
- [ ] 11.4 Complete atomic Inbox conversion/provenance for all destinations and bulk triage with per-item recovery; verify response loss, mixed conflicts, dismiss/restore and no duplicate targets.
- [ ] 11.5 Run parser/capture/domain/UI checks and mobile bundles, document onboarding/triage behavior, then commit/push and verify the remote commit.

## 12. Offline recovery and file lifecycle acceptance

Capabilities: `offline-sync`, `file-storage`.

- [ ] 12.1 Add connectivity/lifecycle scheduling and supported OS background opportunities; verify authentication pause, retry-after/backoff, network restoration and suspension recovery without polling storms.
- [ ] 12.2 Add actual previous-schema SQLite fixtures with drafts/outbox/files and exercise interrupted upgrade/full recovery; verify account isolation, unsupported downgrade safety and no purged-ID resurrection.
- [ ] 12.3 Run sync/cache integration checks and mobile bundles, document the supported offline/upgrade contract and OS limits, then commit/push the sync increment and verify the remote commit.
- [ ] 12.4 Complete scanner readiness/error states and file-type acceptance gaps; verify clean/infected/unavailable/oversized/corrupt fixtures and owner-private grants in storage integration tests.
- [ ] 12.5 Close transfer/cache edge cases for cancellation, restart, sign-out, full disk, clear-cache/share and late native callbacks; verify source/pin preservation and durable private cleanup with actual filesystem fixtures.
- [ ] 12.6 Run attachment/storage suites and mobile bundles, update file/storage runbooks and device test cases, then commit/push the file increment and verify the remote commit; actual scanner/device acceptance remains in group 21.

## 13. Notes, tasks and search completion

Capabilities: `notes-workspace`, `task-workspace`, `search-discovery`. Depends on groups 9 and 12.

- [ ] 13.1 Complete visible note draft-conflict recovery and history/reference edge states; verify lost local writes, remote conflicts, purged-file restore, daily-note idempotency and native-IME browser fixtures without rewriting the stable editor.
- [ ] 13.2 Run notes/editor regression checks and bundles, document supported recovery and remaining physical IME cases, then commit/push the notes increment and verify the remote commit.
- [ ] 13.3 Close task/project UI and recurrence acceptance gaps; verify planned/fixed/floating dates, month-end/DST/end limits, successor/subtask retry safety, project archive and related-record ownership.
- [ ] 13.4 Run task/recurrence/project checks and bundles, document workflow acceptance, then commit/push the task increment and verify the remote commit.
- [ ] 13.5 Complete local/server module and transliteration parity with filters and stable pagination; verify a shared relevance corpus, pending offline records, stale deleted results and account-switch response cancellation.
- [ ] 13.6 Run search/RLS/UI checks, document intentional local/server differences and performance cases, then commit/push the search increment and verify the remote commit.

## 14. Native capture entry points

Capability: `capture-inbox`. Depends on groups 9, 11 and 12.

- [ ] 14.1 Add validated deep-link routing that preserves capture intent through sign-in/unlock; verify malformed destinations, duplicate callbacks and account changes with synthetic native-entry fixtures.
- [ ] 14.2 Implement Android share handling for text/URLs/images/PDFs with durable private handoff; verify lifecycle interruption and duplicate delivery without modifying the user's current emulator.
- [ ] 14.3 Implement the iOS share extension with bounded private handoff and recovery; verify extension fixtures/build on an available appropriate toolchain, recording unavailable iOS execution separately.
- [ ] 14.4 Add Android/iOS home-screen capture widgets, app shortcuts and Android Quick Settings tile; verify each targets the intended destination and respects lock/session ownership in route tests and builds.
- [ ] 14.5 Run available native builds/entry tests, document platform setup and pending physical evidence, then commit/push completed platform increments separately and verify their remote commits.

## 15. End-to-end notification delivery

Capability: `reminder-delivery`. Depends on groups 1, 5, 9 and 12.

- [ ] 15.1 Normalize token transport/platform contracts and add provider submission/receipt adapters with delivery claims; verify invalid/legacy token handling, transient failure, unknown outcome and stable retries using provider fixtures.
- [ ] 15.2 Replace overlapping cancel-all scheduling with serialized occurrence reconciliation and safe coverage reporting; verify scheduling holes, cancellation failures and concurrent refresh do not suppress needed fallback.
- [ ] 15.3 Implement token rotation, sign-out/revocation cleanup and owner-checked tap/snooze/complete actions; verify repeated callbacks and old-account notifications cannot mutate or reveal another account.
- [ ] 15.4 Generate task-due/debt-due/export-ready intents and apply quiet hours, toggles and daily caps; verify explicit timed-reminder exceptions, date-only defaults, timezone travel and deduplication.
- [ ] 15.5 Run delivery/API/mobile-adapter integration checks and bundles, document provider setup, receipts and unsupported-device states, then commit/push and verify the remote commit; measured real delivery remains in group 21.

## 16. Full personal-data lifecycle

Capability: `personal-data-lifecycle`. Depends on groups 2, 5, 6 and 12; readiness notification integrates with group 15.

- [ ] 16.1 Deliver a table/object inventory mapping every current user-owned entity to export/retention/erasure and explicitly excluding secrets; verify it against the schema and storage namespaces with a coverage check.
- [ ] 16.2 Extend export coverage to relationships/preferences/histories/original files with a bounded consistent snapshot and streamed archive; verify representative complete accounts, absent-file failure, exact money values and constrained-memory generation.
- [ ] 16.3 Add attempt manifests, encrypted archive-key handling and cleanup for crashed/superseded exports; verify crash-after-upload recovery, expiry, cancellation and foreign-object protection in storage tests.
- [ ] 16.4 Complete export policy/rate checks and progress/readiness UI; run export/API/UI checks, document archive coverage/consistency, then commit/push the export increment and verify the remote commit.
- [ ] 16.5 Extend erasure with paginated progress, historical multipart recovery and external-processor inventory; verify large synthetic accounts, cancellation/claim races, late uploads and resumable partial failures without reopening writes.
- [ ] 16.6 Add durable erasure-ledger replay to restore tooling and explicit backup-expiry reporting; verify restored fixtures cannot serve erased accounts before replay completes.
- [ ] 16.7 Exercise large retention backlogs, preserved retry/UUID reservations and stalled-cleanup alerts; run lifecycle checks, update deletion/maintenance runbooks and evidence, then commit/push and verify the remote commit.

## 17. AI storage, providers and authorized read tools

Capability: `ai-assistant`. Depends on groups 3-8, 13 and 16; no credentialed model calls are required for deterministic foundations.

- [ ] 17.1 Add the AI package contracts, strict tool registry and versioned prompt structure; verify schema rejection of unknown fields, bounded calls/timeouts and injectable provider fixtures.
- [ ] 17.2 Add owner-scoped conversation/turn/attempt/pending-action/memory persistence with envelope encryption and lifecycle inventory; verify migrations, RLS, key rewrap, export and erasure before enabling any AI data writes.
- [ ] 17.3 Implement minimal-context read/search/Today/money-summary tools through existing domain services; verify foreign references, source permissions, aggregate correctness and context budgets in integration tests.
- [ ] 17.4 Add authenticated SSE chat transport with explicit consent/verification, cancellation and offline drafts; verify stream interruption, AI-off queues and no automatic draft submission on reconnect.
- [ ] 17.5 Run deterministic AI/API/UI checks and bundles, document privacy/provider contracts and disabled-by-default rollout, then commit/push and verify the remote commit.

## 18. AI actions, confirmations and memory

Capability: `ai-assistant`. Depends on group 17 and the corresponding domain workflows.

- [ ] 18.1 Implement the section 29 risk/default/entity-resolution policy and E1/E2/E3 exceptions as deterministic rules; verify question-only intent, ambiguity, person splits, same-conversation/time boundaries and untrusted-context escalation.
- [ ] 18.2 Add immutable expiring pending-action previews and authenticated single-use confirmation; verify tampering, stale versions, expiry, cross-account access and duplicate confirm/replay.
- [ ] 18.3 Implement permitted note/task/reminder/learning/money write tools through domain commands with stable turn/tool identities; verify disconnect-after-commit, Undo and correction without duplicate ledger or recurrence effects.
- [ ] 18.4 Add action/source cards and user-accepted note summarize/extract/rewrite plus safe article/PDF summaries; verify grounded results, unavailable sources and no unsupported bulk/direct rewrite tool execution.
- [ ] 18.5 Add approved memory create/view/edit/delete and conversation retention controls; verify inferred preferences are not silently saved and deletion/export covers all newly introduced records.
- [ ] 18.6 Run policy/tool/API/UI checks and bundles, document action semantics and audit evidence, then commit/push and verify the remote commit.

## 19. AI quotas and evaluation gates

Capability: `ai-assistant`. Depends on groups 17-18.

- [ ] 19.1 Implement per-turn/user/provider quotas, spend limits, transient-only failover and content-minimized telemetry; verify eight-tool/60-second/10-second/two-retry limits and no failover replay of uncertain writes.
- [ ] 19.2 Build a versioned evaluation corpus of at least 300 cases covering section 37 slices, including English/Hinglish/Devanagari, money, ambiguity, injection and cross-account attacks; verify deterministic harness reproducibility and threshold enforcement.
- [ ] 19.3 Add relevant-change CI gates and model/prompt-version reporting; verify a seeded failing policy case blocks enablement and a credential-free run cannot masquerade as live-provider acceptance.
- [ ] 19.4 Run deterministic evaluation/quota checks, document the model-selection spike and provider acceptance procedure, then commit/push and verify the remote commit; live model selection/gates remain in group 21.

## 20. Deployment, observability and recovery tooling

Capability: `release-operations`. Feature-specific instrumentation can land earlier; final integration depends on groups 1-19.

- [ ] 20.1 Add immutable build artifacts, environment-bound staging deployment, migration compatibility checks and smoke/rollback automation; verify pipeline fixtures and a disposable configured environment before allowing promotion.
- [ ] 20.2 Add queue/delivery/sync/storage/deletion/ledger/AI alerts and readiness checks with content-minimized telemetry; verify injected failures produce actionable signals without sensitive payloads.
- [ ] 20.3 Add SAST/dependency/secret scanning and required sensitive-area review controls; verify a synthetic non-secret test violation fails the intended gate and documented exceptions are explicit.
- [ ] 20.4 Implement backup/restore, erasure replay, key rotation and incident runbooks/tooling; verify isolated synthetic restore exercises preserve ownership and cannot serve data before deletion replay.
- [ ] 20.5 Add load/performance harnesses and feature flags/kill switches; verify representative Today/sync/search/AI-mocked loads and flag rollback without loss of pending work.
- [ ] 20.6 Add section 68-70 acceptance-register and release-check tooling while retaining the production guard; verify missing evidence blocks release, then document, commit/push and verify the remote commit.

## 21. External prerequisites and acceptance evidence

These are separate from implementation completion. Do not check an item without the named environment/device/reviewer evidence. Missing credentials or hardware do not prevent independent code increments.

- [ ] 21.1 Configure approved staging domains, OAuth clients, email sender and push identities through the secret manager; verify real sign-in, reset/verification links, transactional email and notification receipts without committing secrets.
- [ ] 21.2 Provision scanner, YouTube quota, private object storage and required KMS bindings; verify clean/infected file handling, metadata/playlist calls and encryption/key-rotation behavior against configured services.
- [ ] 21.3 Execute the AI provider/model-selection spike and the full credentialed evaluation corpus within budget; record chosen configuration, prompt/model versions and every section 37 gate result before enabling AI.
- [ ] 21.4 Run authorized Android/iOS native workflows on the required physical-device matrix, including share/widgets/IME/app-kill/offline files/lock/travel; record device/build/date evidence and resolve failures without assuming access to the user's current emulator.
- [ ] 21.5 Complete TalkBack/VoiceOver, large-text, keyboard, contrast and small-screen acceptance across all core workflows; record reviewer results and verify each material issue is resolved.
- [ ] 21.6 Execute measured notification/performance/load/beta acceptance against specification targets, including 99% timely reminder delivery and 99.5% crash-free sessions; attach sample sizes, conditions and failures to the release evidence.
- [ ] 21.7 Run a representative environment restore drill and storage/queue/provider outage recovery; verify RPO at most five minutes, RTO at most four hours and erasure-ledger replay before traffic.
- [ ] 21.8 Obtain security/penetration, privacy/legal and store-compliance review; verify findings are resolved and final notices, declarations and rollout/incident ownership are recorded.
- [ ] 21.9 Sanitize and commit/push the completed acceptance register and runbook updates; verify no secrets/user data are included and the remote commit matches the recorded evidence revision.

## 22. Final integration and release decision

Depends on all required implementation and acceptance groups; this is not a substitute for their earlier checks.

- [ ] 22.1 Reconcile every v1.0 requirement and section 68 workflow against capability scenarios and evidence; verify no unfinished item is hidden by a checked umbrella task or reassigned to v1.1 without a scope decision.
- [ ] 22.2 Run the complete relevant release regression set on the candidate revision and verify migration/old-client compatibility, restricted-role access and coordinated API/worker/mobile behavior.
- [ ] 22.3 Review the production-guard transition only after acceptance is satisfied; verify missing evidence still blocks promotion and produce a concrete release/rollback plan for explicit release approval.
- [ ] 22.4 Update audit/verification/release notes with actual results, commit/push the completed release-readiness changes and verify the remote candidate; do not deploy or submit stores solely because this planning change is complete.

## Workflow follow-up

- Apply this change only after a new implementation request; the propose workflow ends with planning artifacts.
- Sync capability specs and archive the change only after all required implementation and acceptance tasks are verified complete.
- Perform production promotion and store submission through the separately approved release process.
