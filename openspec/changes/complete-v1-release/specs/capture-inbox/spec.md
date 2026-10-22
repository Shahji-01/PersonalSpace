## Purpose

Make first use and everyday capture quick, understandable and reliable across in-app and native entry points, with user-controlled Inbox triage.

## ADDED Requirements

### Requirement: Onboarding leads to a first useful capture

Onboarding SHALL offer a guided first capture, skippable optional setup and a resumable getting-started checklist. Permissions SHALL be requested in the context of the feature needing them; declining optional setup SHALL leave core capture usable.

#### Scenario: Skip optional onboarding

- **WHEN** a signed-in user skips optional questions and denies notification permission
- **THEN** they can save a first note/task offline and revisit setup later without losing it

### Requirement: Capture suggestions remain deterministic and reviewed

Capture SHALL support Inbox, note, task, expense, learning link and reminder destinations with local date/amount/URL suggestions. Suggestions SHALL not silently perform conversions. Saving SHALL persist locally before success is shown; ambiguous money accounts or reminder times SHALL require resolution.

#### Scenario: Offline expense capture

- **WHEN** a user confirms an amount, category and locally available account while offline
- **THEN** one pending expense is saved and retrying synchronization cannot create a duplicate

#### Scenario: Missing required context

- **WHEN** an expense has no valid account or a reminder time is ambiguous
- **THEN** the UI asks for the missing choice or offers to preserve the text in Inbox

### Requirement: Native entry points preserve capture intent

Android and iOS share entry points and home-screen widgets, Android Quick Settings and app shortcuts SHALL open the appropriate capture flow. Shared URLs, text, images and PDFs SHALL retain source provenance and follow private-file validation. Deep links SHALL accept only supported destinations and validated input.

#### Scenario: Share while locked or signed out

- **WHEN** content is shared into an app that requires unlocking or sign-in
- **THEN** the content is kept private and a destination account is established before it can be persisted or uploaded

#### Scenario: Duplicate share callback

- **WHEN** the same native share operation is delivered twice during restart
- **THEN** it does not silently create duplicate records or uploads

### Requirement: Inbox conversion is atomic and supports bulk triage

Users SHALL convert Inbox items into each supported destination, dismiss and restore them, and multi-select compatible items for reviewed triage. Conversion SHALL create the destination and provenance together, preserve account ownership, and remain idempotent under offline replay. Expense/reminder creation SHALL always require user confirmation.

#### Scenario: Conversion response lost

- **WHEN** conversion succeeds but the client retries after losing the response
- **THEN** the original destination is returned and only one provenance link exists

#### Scenario: Bulk operation includes a conflict

- **WHEN** a selected item has changed or disappeared
- **THEN** the UI reports per-item outcomes, retains failed selections for recovery and does not duplicate successful conversions
