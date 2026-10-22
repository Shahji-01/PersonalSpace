## Purpose

Preserve rich notes and their organization through editing, interruptions, conflicts and history restoration, with usable native interactions.

## ADDED Requirements

### Requirement: Rich editing preserves durable drafts

The editor SHALL preserve supported rich text, checklists, code, links and file references across offline edits, app interruption and restart. It SHALL report unsaved or failed writes truthfully and support native keyboard/IME composition without losing or duplicating input.

#### Scenario: App stops after a local save

- **WHEN** the app stops after reporting a draft saved but before network synchronization
- **THEN** reopening the same account restores that draft and its pending state

#### Scenario: Local write fails

- **WHEN** local storage rejects a draft write
- **THEN** the editor retains recoverable text and shows a retryable error instead of reporting the draft saved

### Requirement: Conflicts and history remain recoverable

Conflicting edits SHALL preserve both the confirmed server content and the recoverable local draft. Users SHALL inspect checkpoints and restore a chosen version with version checks; restoring content SHALL not resurrect purged files or foreign-account references.

#### Scenario: Remote edit races with local save

- **WHEN** two devices edit the same base version
- **THEN** a stale write cannot overwrite the newer content silently and the user can open or copy their local recovery version

#### Scenario: History refers to a purged file

- **WHEN** a user restores a checkpoint containing a permanently removed attachment
- **THEN** the note is restored with an unavailable-file state and no file bytes or download access are recreated

### Requirement: Organization and references stay consistent

Folders within the specified depth limit, tags, pin/favorite/archive, daily notes, backlinks and Trash SHALL remain searchable and consistent after rename, move, restore and offline replay. Reference pickers and history controls SHALL be accessible and reveal only the active account's records.

#### Scenario: Referenced note is deleted

- **WHEN** a linked note enters Trash or is purged
- **THEN** references display the appropriate unavailable state and search excludes it according to the selected Trash filter

#### Scenario: Retry opening a daily note

- **WHEN** the same account requests its daily note repeatedly for the same effective date
- **THEN** it opens one logical daily note without duplicates
