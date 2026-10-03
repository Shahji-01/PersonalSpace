# Timed deadlines and project notes

## Deadline behavior

Migration 0017 adds optional wall-clock time, timezone intent and a fixed UTC instant to task deadlines. Existing date-only deadlines remain floating and have no timezone or instant. The planned date stays separate. `task.setDeadline` validates the full deadline atomically; the legacy `task.setDueDate` command explicitly returns to date-only behavior.

Local-time deadlines store the creation timezone for context and resolve in the device's current timezone. During daylight-saving transitions, resolution uses the first repeated time and advances skipped times by the gap. Fixed deadlines keep their chosen timezone and resolved UTC instant: nonexistent local times are rejected, and repeated times require choosing the first or second occurrence. Today/Upcoming convert fixed instants into the current local date; timed Overdue compares the instant with the current time. Closed, archived and trashed tasks are excluded from Overdue.

Shared calculations use pinned `@js-temporal/polyfill` 0.5.1 and the device's Intl timezone data. The explicit disambiguation policy follows the [Temporal ZonedDateTime specification documentation](https://tc39.es/proposal-temporal/docs/zoneddatetime.html). Tests cover travel, spring gaps, autumn folds, half-hour transitions and month-by-month round trips across seven timezones. Native Hermes runtime/timezone acceptance remains pending; bundle compilation does not verify every device's timezone database.

Mobile task Details contains the date, optional 24-hour time, local/fixed controls and fixed timezone field. Clearing the fields and saving removes the deadline. Natural-language time parsing, recurrence and notification scheduling are separate remaining features.

## Project-related notes

Migration 0018 adds the `related` relation to existing owner-scoped entity links. `project.setNotes` accepts up to 100 unique note IDs and checks project ownership/version plus ownership and availability of every note. Saving returns a project record with sorted `relatedNoteIds`; older cache/response records default to an empty list. Link changes share the normal offline command, idempotency, audit and sync path.

Projects expose a searchable note picker with link/unlink and open-note controls. Pending new notes must sync before they can be linked. Archived notes can be linked. Existing links survive Trash and restore, but newly linking a trashed note is rejected. Removing a link preserves the note and any capture provenance.

Permanent note deletion removes related links and advances every affected project's version in the same transaction. Its response and incremental pull include those updated projects alongside the note's purge marker, preventing stale links on other devices. The permanent purge itself targets only the requested content, never the related projects. Integration tests exercise retries, conflicts, foreign ownership, duplicate IDs, Trash/restore, unlinking and permanent deletion. Native screen interaction is deferred at the user's request. Related learning resources and structured note-to-note backlinks remain separate work.
