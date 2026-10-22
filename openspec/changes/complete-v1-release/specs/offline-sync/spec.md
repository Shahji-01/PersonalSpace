## Purpose

Keep supported offline work durable and account-isolated while synchronization recovers safely from connectivity loss, authentication expiry and protocol recovery.

## ADDED Requirements

### Requirement: Offline mutations survive retries and account changes

Supported mutations SHALL persist before local success is shown and retain stable mutation identities across retry and restart. Switching accounts SHALL hide the previous account's data without discarding unsynced work or replaying it under the new account.

#### Scenario: Server commits before the connection fails

- **WHEN** a mutation commits remotely and the response is lost
- **THEN** replay returns the original outcome without a second domain change

#### Scenario: Account switch with pending work

- **WHEN** a user signs into a different account while earlier work remains queued
- **THEN** only the new account's data is visible and the old queue waits for its own authenticated context

### Requirement: Synchronization responds to lifecycle and connectivity

Foreground/resume and network restoration SHALL trigger eligible synchronization with bounded backoff, server retry timing and authentication pauses. Supported OS background opportunities SHALL be used within platform limits without promising continuous background execution.

#### Scenario: Connectivity returns after a failure

- **WHEN** a device becomes online with retryable pending work
- **THEN** synchronization resumes within its eligible retry window without requiring manual record edits

#### Scenario: OS suspends background execution

- **WHEN** the OS terminates a background synchronization attempt
- **THEN** pending work remains durable and resumes safely on the next allowed opportunity

### Requirement: Full recovery preserves local intent and deletions

Expired-cursor recovery SHALL rebuild server state resumably while preserving unsynced commands and recoverable drafts. Retained deletion reservations SHALL prevent a stale client from resurrecting purged records.

#### Scenario: Old device submits a purged identifier

- **WHEN** a device resumes after the server's incremental history window and replays a purged entity ID
- **THEN** recovery does not recreate that entity and reports the rejected local operation recoverably

### Requirement: Cache upgrades protect existing work

Supported local schema upgrades SHALL be transactional and tested from retained prior versions with pending mutations, drafts and file manifests. An unsupported downgrade SHALL fail with a recoverable explanation rather than delete account data.

#### Scenario: Upgrade interrupted

- **WHEN** an upgrade stops before completion
- **THEN** reopening reaches either the intact previous schema or the completed schema without losing queued work
