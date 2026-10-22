## Purpose

Keep attachment bytes private and verifiable throughout upload, processing, offline use, sharing and deletion across supported mobile platforms.

## ADDED Requirements

### Requirement: Files remain private through processing and access

Files SHALL use owner-authorized private grants, quota/type/size checks, verified checksums and scanning before ready access. Images SHALL follow the specified sanitization policy. A scanner failure SHALL not be treated as a clean scan, and removal SHALL revoke new grants promptly.

#### Scenario: Scanner unavailable

- **WHEN** scanning cannot complete
- **THEN** the file remains unavailable as a ready attachment with a recoverable processing state

#### Scenario: Foreign or expired download grant

- **WHEN** an unauthorized account requests a file or a client uses an expired grant
- **THEN** access is refused without exposing the file or its metadata

### Requirement: Native transfers are resumable and truthful

Picker, upload, cancellation, preview and sharing flows SHALL preserve source files, resume supported interrupted uploads, verify downloaded bytes and show pending/progress/error states. Sign-out and parent deletion SHALL prevent late callbacks from attaching files to another account or resurrecting deleted content.

#### Scenario: Picker returns after sign-out

- **WHEN** a picker callback returns after the initiating account signs out
- **THEN** no file is added or uploaded under the next account

#### Scenario: Upload interrupted by app termination

- **WHEN** the app stops during an upload and later restarts
- **THEN** transfer state is recovered without duplicating the logical attachment or losing its recoverable local source

### Requirement: Offline cache respects pins and storage limits

Verified cached files SHALL open and share offline. Eviction and clear-cache operations SHALL respect offline pins and unsynced originals, reclaim only owned cache bytes, and explain insufficient storage. Corrupt or missing cache entries SHALL not be served as valid files.

#### Scenario: Storage pressure with pinned files

- **WHEN** cache capacity is exhausted by protected entries
- **THEN** new caching pauses with an actionable message rather than deleting pins or unsynced originals

#### Scenario: Corrupt offline copy

- **WHEN** a cached file fails integrity validation
- **THEN** it is unavailable until a verified replacement is obtained and the UI explains why

### Requirement: Cleanup survives storage outages

Abandoned transfers, processing failures, superseded objects and removed files SHALL retain durable cleanup intent until storage confirms deletion. Versioned objects and multipart uploads SHALL be included, and cleanup SHALL never delete another account's objects.

#### Scenario: Storage deletion fails

- **WHEN** storage is unavailable during cleanup
- **THEN** access remains revoked, tracked cleanup information remains durable and retry resumes after recovery
