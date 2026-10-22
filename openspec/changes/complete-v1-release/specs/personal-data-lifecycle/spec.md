## Purpose

Give users trustworthy access to and deletion of their personal data while preserving recoverability, private access and retry safety throughout lifecycle jobs.

## ADDED Requirements

### Requirement: Exports cover the declared data scope

An everything export SHALL include the user's application data, relationships, preferences, applicable histories and original attachments, with a manifest describing coverage and any unavailable items. JSON and CSV/Markdown archives SHALL preserve stable identifiers and money semantics. Large exports SHALL have bounded resource use and a documented consistent snapshot boundary.

#### Scenario: Export contains histories and files

- **WHEN** a user exports an account containing revisions, attachments and related entities
- **THEN** the manifest identifies included records/files and any exclusions explicitly rather than silently calling a partial dataset complete

#### Scenario: File unavailable during export

- **WHEN** an attachment cannot be read during generation
- **THEN** the job retries or reports its incomplete state and does not label the archive a complete successful export

### Requirement: Export delivery and cleanup are recoverable

Exports SHALL require verified email and recent authentication, enforce rate limits, expose progress/failure states and notify readiness. Downloads SHALL be private and expire after the specified window. Failed/superseded attempts SHALL retain enough information to remove orphan objects safely.

#### Scenario: Worker crashes after uploading an archive

- **WHEN** upload succeeds before the job records completion
- **THEN** retry/recovery can identify the attempt's object, avoid exposing an untracked archive and eventually remove abandoned bytes

#### Scenario: Expired export during storage outage

- **WHEN** download authorization expires while object cleanup cannot reach storage
- **THEN** new download grants are refused and physical cleanup remains queued

### Requirement: Account erasure is fenced and truthful

Account deletion SHALL require recent authentication, support cancellation during the defined grace period and fence further writes when erasure begins. Progress SHALL survive crashes and cover database, authentication, objects/versions, multipart uploads and configured external processors. Completion SHALL distinguish live-system erasure from disclosed backup expiry obligations.

#### Scenario: Erasure interrupted on a large account

- **WHEN** a deletion worker stops midway through object or record cleanup
- **THEN** another attempt resumes from durable progress without reopening writes or erasing another account

#### Scenario: Backup later restored

- **WHEN** a backup predating completed deletion is restored
- **THEN** the erasure ledger is reapplied before serving restored data, preventing deleted accounts from reappearing

### Requirement: Retention preserves replay and recovery guarantees

Trash SHALL remain restorable for its specified retention period and then purge through audited, versioned cleanup. Retry deduplication and entity deletion reservations SHALL remain sufficient to prevent stale retries from recreating removed data. Maintenance SHALL process bounded batches and report stalled work.

#### Scenario: Restore races with purge

- **WHEN** a user restore and retention purge target the same record concurrently
- **THEN** one valid serialized outcome occurs and sync/file state matches it

#### Scenario: Large retention backlog

- **WHEN** expired records exceed one maintenance batch
- **THEN** repeated passes make observable progress without starving child records or discarding retry reservations
