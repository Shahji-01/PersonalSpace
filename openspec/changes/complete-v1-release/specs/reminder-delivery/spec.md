## Purpose

Deliver reminders and other v1.0 notifications reliably while coordinating local schedules, server delivery, user preferences and device lifecycle.

## ADDED Requirements

### Requirement: Server notification state reflects actual transport

Server notifications SHALL be submitted to the configured push transport with stable logical delivery identities, bounded retries and receipt reconciliation. A queued log record SHALL NOT count as delivery; invalid tokens SHALL be retired and uncertain outcomes SHALL remain distinguishable from confirmed success.

#### Scenario: Provider temporarily unavailable

- **WHEN** a due notification cannot be submitted
- **THEN** its delivery intent remains retryable without falsely marking provider delivery complete

#### Scenario: Invalid device token

- **WHEN** a receipt identifies a permanently invalid token
- **THEN** the registration is retired without disabling other valid devices for the account

### Requirement: Local coverage cannot hide unscheduled reminders

Local/server coordination SHALL suppress fallback only for reminders known to be scheduled successfully for that device. Rescheduling SHALL reconcile changes safely, preserve failures for retry and avoid concurrent scheduling races. Displayed scheduled counts SHALL reflect successful operations.

#### Scenario: Earlier local reminder fails

- **WHEN** a later reminder schedules successfully but an earlier one fails
- **THEN** the reported coverage does not suppress server fallback for the failed reminder

#### Scenario: Schedule replaced during refresh

- **WHEN** two record refreshes overlap while reminders are being scheduled
- **THEN** the resulting schedule reflects the latest records without losing reminders through competing cancellation passes

### Requirement: Notification policy covers all v1 types

Reminder, task-due, debt-due and export-ready notifications SHALL honor per-type preferences, timezone semantics and quiet hours. Explicitly timed reminders inside quiet hours SHALL remain eligible; non-reminder notifications SHALL be limited to five per day under the product policy.

#### Scenario: Task due during quiet hours

- **WHEN** a non-reminder notification becomes due during quiet hours
- **THEN** it is deferred or suppressed according to policy and does not bypass the user's type toggle or daily limit

#### Scenario: Explicit reminder inside quiet hours

- **WHEN** a user explicitly schedules an enabled reminder inside quiet hours
- **THEN** it remains eligible at the requested time

### Requirement: Device and action lifecycle preserves ownership

Registration, rotation, sign-out and session revocation SHALL keep notification ownership current. Notification taps, snooze and completion SHALL validate the active account and current entity state, remain retry-safe and reveal no private content before app unlock.

#### Scenario: Old-account notification tapped

- **WHEN** a notification from a previous account is tapped after an account switch
- **THEN** its content is not shown under the new account and no mutation is applied to either account without the proper context

#### Scenario: Snooze action retried

- **WHEN** the OS repeats a snooze action callback
- **THEN** one logical snooze transition occurs and its new delivery replaces the prior occurrence
