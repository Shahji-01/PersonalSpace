## Purpose

Give users a coherent daily overview of their own tasks, reminders, learning progress and spending without requiring a connection to see cached information.

## ADDED Requirements

### Requirement: Today combines the v1 daily sections

Today SHALL show overdue and today's tasks, a reminder schedule, continue-learning items and today's/monthly spending from the active account's local data. Empty sections SHALL collapse, section ordering SHALL be configurable, and each populated section SHALL link to its relevant workflow.

#### Scenario: Return to Today offline

- **WHEN** a user with cached tasks, reminders, learning and money opens Today offline
- **THEN** the sections render cached data with pending/stale indicators and no loading screen that waits indefinitely for the network

#### Scenario: Account changes

- **WHEN** the active account changes
- **THEN** no section displays the previous account's records or aggregates

### Requirement: Overdue rollover is explicit

A task SHALL appear in Today when planned today, due today or overdue and unfinished. Overdue dates SHALL not change automatically; a reviewed move-to-today action SHALL preserve due-date semantics and report conflicts.

#### Scenario: New calendar day

- **WHEN** midnight passes with an unfinished overdue task
- **THEN** the task remains visible without silently changing its planned or due date

### Requirement: Daily totals and time boundaries are consistent

Today SHALL use the user's effective timezone and the canonical money rules for its totals, excluding void transactions and transfer double counting. An optimistic local mutation SHALL affect the overview once and reconcile with the confirmed version without duplication.

#### Scenario: Pending expense synchronizes

- **WHEN** a locally saved expense contributes to today's total and later receives server confirmation
- **THEN** the total remains unchanged unless the confirmed data differs and the UI clears its pending state

#### Scenario: Timezone changes

- **WHEN** the user changes timezone
- **THEN** Today recalculates calendar boundaries while preserving fixed-instant deadlines and money date semantics
