## Purpose

Make tasks, recurring work, subtasks and projects dependable across devices while preserving the distinction between planning dates and deadlines.

## ADDED Requirements

### Requirement: Task operations preserve date and ownership semantics

Task creation/editing, status, priority, description, estimates, tags and project assignment SHALL preserve planned versus due dates and floating versus fixed-time deadlines. One-level subtasks and related notes/resources SHALL be restricted to the same account and expose pending, failed and conflicting mutations.

#### Scenario: Travel with a fixed deadline

- **WHEN** a device changes timezone with a fixed-instant task deadline
- **THEN** the instant remains unchanged while its displayed local time changes appropriately

#### Scenario: Foreign project assignment

- **WHEN** a task is assigned to a project belonging to another account
- **THEN** the operation fails without exposing that project's existence or changing the task

### Requirement: Recurrence produces one valid successor

Fixed-schedule and after-completion recurrence SHALL respect interval, weekday, end-count/date, month-end and daylight-saving rules from the product specification. Completing or modifying an occurrence SHALL apply the selected occurrence/future scope and SHALL NOT produce duplicate successors on replay.

#### Scenario: Completion response is lost

- **WHEN** a recurring-task completion is retried with its original mutation identity
- **THEN** exactly one successor and the intended subtask copies exist

#### Scenario: Series end reached

- **WHEN** the final allowed occurrence completes
- **THEN** no successor is created and the completed occurrence remains available

### Requirement: Project lifecycle is usable and reversible

Users SHALL create, rename, reorder and archive projects, filter their tasks, and manage related notes/resources. Archive and Trash operations SHALL preserve the defined child behavior and offer recovery before permanent purge; stale versions SHALL produce recoverable conflicts.

#### Scenario: Project changes on another device

- **WHEN** an offline project edit is replayed against a newer version
- **THEN** the client shows a conflict with a recovery path rather than silently replacing the remote edit

#### Scenario: Project archived

- **WHEN** a user archives a project
- **THEN** it leaves active project selection while remaining reachable through archived views with its valid relationships preserved
