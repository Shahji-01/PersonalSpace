# Proposal

## Why

PersonalSpace has substantial notes, tasks, sync and attachment implementations, but its remaining delivery defects and incomplete mobile workflows prevent users from relying on the full v1.0 product. The October 2026 source audit found missing push transport, unreachable background schedule registration, stale money balances, incomplete authentication recovery and settings behavior, and an unimplemented AI assistant; release acceptance is also outstanding.

## What Changes

- Complete the remaining **v1.0** behavior in `PersonalSpace-Specification-v1.2.md`, preserving existing implemented workflows. The specification version is not the target release number.
- Repair background scheduling, durable email delivery, metadata fetch security and transactional money balance maintenance before building dependent flows.
- Complete identity recovery, verified-email and recent-authentication checks, session management, notifications, exports and account erasure guarantees.
- Finish Today, onboarding/capture/Inbox, Money and Learning workflows; make saved preferences work; deliver native capture, app lock and accessible mobile UI states.
- Complete offline recovery and file acceptance while preserving account isolation, retry safety and existing rich notes/task behavior.
- Add the optional-to-use v1.0 text AI assistant, domain-backed tools, confirmations, consent, memory, citations, quotas and evaluation gates.
- Establish deployment, observability, recovery, security and native release evidence. Production remains gated until the requirements are satisfied.
- Deliver this program in ordered, reviewable increments, each with checks, evidence, a commit and a push. A completed code increment does not mark unavailable provider/device acceptance complete.
- Exclude v1.1 full web app, planner, habits, voice, budgets, recurring transactions, import, briefing, full local-first sync and bulk AI operations. Later integrations, semantic search, extensions and billing are also excluded. The v1.0 web shell and email-link journeys remain included.

## Capabilities

### New Capabilities

These are new OpenSpec capability records, not claims that all underlying product behavior is new. There are no existing main capability specs to modify.

- `background-delivery`: Startup schedules and durable, private transactional email processing.
- `identity-access`: Authentication recovery, verified/step-up access, sessions and consent history.
- `capture-inbox`: Guided onboarding, deterministic capture, native entry points and reviewed Inbox triage.
- `daily-overview`: A cache-first Today screen combining tasks, reminders, learning and money.
- `notes-workspace`: Completion and acceptance of rich notes, history, references and conflict recovery.
- `task-workspace`: Completion and acceptance of tasks, recurrence, subtasks and projects.
- `offline-sync`: Account-isolated replay, recovery, connectivity and cache upgrades.
- `file-storage`: Private files, processing, offline cache and native transfer lifecycle.
- `reminder-delivery`: Local/server notification coordination, delivery receipts and notification policy.
- `learning-library`: Safe metadata, collection editing, playback and progress.
- `money-ledger`: Correct balances, splits, debts, revisions and complete mobile money workflows.
- `search-discovery`: Account-scoped local/server search, filters, transliteration and relevance.
- `mobile-experience`: Applied preferences, app privacy, navigation, localization and accessibility.
- `personal-data-lifecycle`: Complete exports, erasure, Trash and retention recovery.
- `ai-assistant`: Opt-in text assistance, authorized tools, confirmation, memory and evaluations.
- `release-operations`: Reproducible deployment, telemetry, recovery and launch acceptance.

### Modified Capabilities

None; the main OpenSpec capability inventory is currently empty.

## Impact

- **Applications:** `apps/mobile` screens/native integrations, `apps/api` authentication and routes, `apps/worker` scheduling/processors, and `apps/web` v1.0 link/legal/deletion journeys.
- **Shared code:** domain services, validation/API client, PostgreSQL schema/RLS/migrations, SQLite sync/storage, NLP, editor and UI packages; a new `packages/ai` boundary for assistant orchestration.
- **Persistence/API:** additive delivery claims, session/consent state, balance propagation, playback state and AI records need reviewed contracts and forward migrations. Existing mutation IDs, entity versions and deletion reservations must remain valid. No destructive reset or intentional public API break is proposed.
- **External systems:** push/email/OAuth/YouTube/AI providers, file scanner, private object storage, deployment environments, observability, KMS and backups. Credentials and provisioning are separate execution prerequisites, never committed artifacts.
- **Evidence:** extend existing tests and `docs/project-audit.md`, `docs/verification.md`, operational runbooks and ADRs. Current uncommitted development-preview edits are outside this change unless separately reconciled during implementation.
