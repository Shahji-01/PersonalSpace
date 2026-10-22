## Purpose

Make release readiness measurable and deployments recoverable, with evidence for security, privacy, native behavior and service reliability.

## ADDED Requirements

### Requirement: Releases are reproducible and recoverable

CI SHALL validate formatting, types, lint, unit/integration/RLS checks, migrations, relevant UI tests and builds, plus security and applicable AI evaluation gates. Releases SHALL use immutable revisions, automated staging deployment/smoke checks, explicit production promotion and health-based rollback compatible with applied migrations.

#### Scenario: Staging health check fails

- **WHEN** a deployment fails health or smoke checks
- **THEN** promotion is blocked and the previous compatible release is restored without reversing committed user data

#### Scenario: Migration applied before application rollback

- **WHEN** application code is rolled back after an additive migration
- **THEN** the prior supported application continues operating without dropping new tables or resetting data

### Requirement: Operations expose actionable content-minimized signals

Metrics and alerts SHALL cover request errors/latency, queue lag, delivery failures, sync recovery, storage cleanup, balance drift, deletion backlog and AI cost. Logs/crash reports SHALL exclude credentials and user content. Health/readiness SHALL distinguish unavailable required providers from a working process.

#### Scenario: Queue backlog persists

- **WHEN** delivery work exceeds its documented operational threshold
- **THEN** an alert identifies the affected service and runbook without exposing message or financial content

### Requirement: Recovery meets the documented data objectives

Encrypted backups and restore procedures SHALL support the specified RPO of at most five minutes and RTO of at most four hours. Restore drills SHALL verify account isolation, deletion-ledger replay, private objects and queue/outbox recovery before serving traffic.

#### Scenario: Restore drill

- **WHEN** an isolated environment is restored from a representative backup
- **THEN** measured recovery times and recovered data meet the objectives and erased accounts do not reappear

### Requirement: Native and performance acceptance is evidenced

Release acceptance SHALL cover the section 68 v1.0 workflows on Android/iOS and the section 70 device matrix. Normal-state reminder delivery SHALL meet 99% within 60 seconds, beta crash-free sessions SHALL reach 99.5%, and performance/load checks SHALL meet sections 54-55. Bundles and mocked tests SHALL NOT substitute for physical-device evidence.

#### Scenario: Only a headless check exists

- **WHEN** a native workflow has passed browser or mocked tests but has no required device result
- **THEN** it remains pending native acceptance and cannot be reported as fully release-verified

### Requirement: Launch remains gated by security and privacy evidence

Production enablement SHALL require recorded security review/penetration testing, privacy/legal and store declarations, provider configuration, accessibility acceptance and staged-rollout/incident procedures. Required encryption, secret handling and dependency controls SHALL be verified. Unavailable external prerequisites SHALL remain explicit pending gates.

#### Scenario: Provider or review evidence missing

- **WHEN** implementation is complete but required provider credentials, device results or launch review are missing
- **THEN** the release gate stays closed with the missing prerequisite identified
