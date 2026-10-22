## Purpose

Ensure scheduled work and transactional email survive startup, outages and retries without exposing private content or reporting false success.

## ADDED Requirements

### Requirement: Schedules are available during normal operation

The worker SHALL establish each required metadata, notification, email, deletion and maintenance schedule while running, independently of unrelated schedules, and SHALL retry transient registration failures without duplicating logical schedules.

#### Scenario: Empty queue service on startup

- **WHEN** a worker starts against an empty available queue service
- **THEN** all required schedules become available before shutdown and each has one logical identity

#### Scenario: Queue outage during startup

- **WHEN** registration fails and the queue service later recovers
- **THEN** the running worker retries registration and processing resumes without a restart

### Requirement: Email delivery has durable ownership and recovery

The system SHALL claim email work exclusively for a bounded lease, retry transient failures with bounded backoff, recover expired claims and retain terminal failure state. Retrying one logical message SHALL preserve its provider idempotency identity.

#### Scenario: Concurrent workers and crash

- **WHEN** two workers compete for a message and the claimant crashes
- **THEN** only one active claim exists and a later worker can recover it after expiry using the same delivery identity

#### Scenario: Permanent rejection

- **WHEN** the provider rejects the recipient permanently
- **THEN** the message is recorded as terminally failed with a sanitized reason and is not retried indefinitely

### Requirement: Delivery status reflects provider evidence

The system SHALL distinguish queued, processing, retrying, accepted, delivered where receipts exist, failed and development-preview outcomes. Missing production delivery configuration SHALL fail readiness; a console preview SHALL NOT count as sent email.

#### Scenario: Preview without a provider

- **WHEN** a development environment processes an email without a real provider
- **THEN** the result identifies preview or unavailable delivery and never reports provider acceptance

#### Scenario: Timeout after an uncertain send

- **WHEN** a send times out without a conclusive response
- **THEN** the delivery remains recoverable with its original idempotency identity and does not fabricate a delivered result

### Requirement: Transactional messages preserve privacy and intent

The system SHALL durably enqueue required authentication, account and export messages with the triggering action, use the intended account and purpose, and keep tokens, recipient addresses, message bodies and raw provider responses out of operational logs. All v1.0 templates SHALL provide usable links and expiry information.

#### Scenario: Enqueue failure

- **WHEN** durable enqueue fails during an operation that promises a required email
- **THEN** the operation rolls back or reports a recoverable failure instead of silently claiming an email was sent

#### Scenario: Provider error

- **WHEN** a provider returns a response containing recipient data or a token
- **THEN** stored diagnostics and logs contain only approved error categories and correlation identifiers
