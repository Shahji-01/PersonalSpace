# Note editor

Notes use the shared `packages/editor-schema` v1 ProseMirror document format. The existing paragraph-only documents already conform to v1; migration 0006 adds an explicit schema version without rewriting content. Unknown future versions fail validation rather than losing formatting.

Mobile Quick Capture remains a fast plain-text input. Editing a synced note opens a bundled Tiptap editor in an Expo DOM component. The editor supports headings (levels 1–3), bold, italic, bullet/numbered lists, checklists, blockquotes, links, inline code, code blocks, and undo/redo. Library previews use native views. Editor assets are included in Android/iOS exports and do not use a CDN.

`note.updateContent` accepts validated JSON and the record's base version. The server derives the title and searchable text, then commits the note, entity version, audit event, and outbox event in the existing transaction. Sync carries both the canonical document and plain text. The legacy `note.edit` command continues to work for paragraph-only notes but rejects formatted notes to prevent accidental flattening.

The shared schema rejects unknown nodes/attributes, unsafe link protocols, more than 100,000 text characters, more than 10,000 nodes, or nesting deeper than 16. HTML pasted into the editor is interpreted by the configured Tiptap schema; the API accepts structured JSON, not arbitrary HTML. Links do not navigate the editing WebView. Markdown conversion is available in the shared package; a user-facing export flow is still pending.

Every valid editor change is queued to account-scoped SQLite draft storage. “Draft saved on this device” is shown only after that write succeeds. Close preserves the draft; Discard draft requires confirmation. Save changes also preserves the draft while its mutation is pending. Acknowledgement clears only the exact document/base-version pair that was accepted. Conflicts retain the local draft and restore the accepted record; a draft based on an older version must be reconciled rather than silently overwriting the newer note. Permanent note purge also removes its local draft after acknowledgement.

## Acceptance still required

The implementation does not decide ADR-027. Run the specification's editor spike on a 3–4 GB Android phone and an older supported iPhone: 5,000-word notes editable within 500 ms, keystrokes within 50 ms, Hindi/English Gboard and SwiftKey composition, caret/keyboard scrolling, app-kill recovery offline, TalkBack and VoiceOver. Automated schema, SQLite, API tests and emulator checks do not replace those measurements.

Inline file references are implemented; inline image/thumbnail rendering and cross-device draft merging remain unfinished. Saved-version history, editing checkpoints, folders and backlinks are implemented.

## Inline files

**Insert file** opens a searchable, phone-width picker of registered attachments belonging to the current note. **Add file** saves the draft first, then uses the existing native picker and durable transfer queue; the new upload appears when metadata sync reaches the editor. Processing files can be inserted as placeholders. File labels show current filename, size and processing/download/offline status. Long filenames wrap, controls support keyboard access, and unavailable files retain an explicit label. Opening a ready file saves the draft before invoking the verified cache/download/share flow. A failed draft write keeps the editor open and prevents the native action.

An `attachmentReference` inline atom stores only `{ attachmentId }`, never a filename, URI, storage key or signed grant. Filenames/status resolve from account-scoped records and local cache state, including durable offline removals. Save, history checkpoint, history restore and draft copy validate every distinct ID against the owner's attachment registry (maximum 100). Foreign, unknown and wrong-type IDs are rejected atomically. Owned purged IDs remain valid unavailable placeholders in old drafts/history; saving them cannot recreate metadata or bytes. Task descriptions reject these nodes.

Removing a label from the text leaves the upload intact; **Files** manages deletion. A recovered draft copy keeps references to the original files rather than duplicating their bytes or changing their parent. Downloads remain subject to the original parent note's lifecycle. When that parent or file is deleted, references in other notes become unavailable. Native Library/history previews resolve filenames when their records are available. Plain text uses `[[File]]`; Markdown uses `[[file:UUID]]`, leaving file packaging/resolution to a future full export implementation.

This is an additive change to the development v1 document schema: update API and mobile together. Older clients reject the unfamiliar node rather than flattening it. Browser tests use the real DOM editor with synthetic native callbacks; native picker/share-sheet/WebView-bridge and screen-reader acceptance remain open. Inline image previews and eager thumbnails are separate remaining work.

## Recovering conflicting drafts

If a note changes elsewhere while a local draft is open or waiting to sync, the editor disables Save changes and offers Save as separate note. Failed note saves/checkpoints also expose Review draft on the main screen. Copying preserves the full document, creates a regular note in the source's current folder, and keeps a stable `recoveredFromId` link. The copy is labelled in Library, offers Open original note, and appears in the original's Linked from section. The server's content/version stays unchanged. This is an explicit recovery choice; automatic CRDT merging and the complete v1.1 conflict policy remain open. Task-description drafts remain preserved but do not yet have this copy action.

The copy command is idempotent, owner-checked, indexed and snapshotted through the normal transaction. A trashed source must be restored first; a permanently purged or foreign source cannot create a copy. Locally, only one copy of a source may be pending. The original draft and matching failed save stay until the copy is acknowledged; only an exact content/base-version match is then cleared. A newer draft is preserved. Permanent source deletion cancels unacknowledged copies, while already published copies remain independent notes. Migration 0023 adds the owner-constrained source link.

## Editing checkpoints

Changed note content queues a history checkpoint every ten minutes while the editor is visible. Closing the editor, using Android's back action or following a note link saves the local draft and queues a session-end checkpoint before leaving. Unchanged content is deduplicated. Explicit Save changes uses the normal content-save snapshot. Task descriptions keep local drafts but do not use note-history checkpoints.

Checkpoints use the durable SQLite outbox and the same owner/base-version checks and history retention as saves. They preserve the published note content, title, version, search index and backlink relations; Save changes publishes the edit. Pending checkpoints do not block a later explicit save or clear the local draft when acknowledged. Stale, trashed and purged notes reject new checkpoints. Permanent purge erases stored and queued checkpoint content.

History may therefore contain unfinished edits from another device after sync. Restore creates a new published version through the normal version-checked command. Discard draft removes the local draft; it does not erase already queued or synced history. Abrupt process termination cannot guarantee a session-end callback, so per-change local drafts remain the recovery mechanism. Previously loaded history is available offline; unseen server history requires connectivity.

## Automated browser checks

`pnpm test:editor` bundles the actual Expo DOM editor into a separate local browser harness and exercises it at 390px width. It checks formatting, undo/redo, checklists, safe links, save JSON, draft recovery after reload, timed/session-end checkpoints, storage-error handling and overflow. On Windows, `PLAYWRIGHT_CHANNEL=chrome` uses the installed Chrome. The harness does not connect to the emulator or real user data.

The tests caught incompatibilities with the installed Tiptap version: link marks include a nullable `title`, and interactive checklist node views do not put `data-type` on each `li`. The shared schema and CSS now match those shapes. Disabling the editor during Save/Close does not emit an extra content update.

## Structured note references

Typing `[[` opens a searchable picker; the toolbar also offers Link note. The user selects a synced note by title, with context shown to distinguish duplicate titles. A `noteReference` inline node stores only its UUIDv7. Current titles come from account-scoped records in the editor and native previews, so renames update the display without rewriting source content or history. Missing, trashed or purged targets display “Unavailable note.” Existing unsynced notes are excluded from the picker until acknowledged.

Migration 0019 enables `entity_links.relation = references`. Content save and history restore validate every target against the owner's note registry, replace only reference relations and deduplicate repeated targets in the same transaction. Up to 100 distinct targets are allowed. Foreign, unknown and non-note IDs are rejected atomically. Owned permanent-deletion markers may remain in old draft/history JSON; saving those documents does not recreate links to purged notes. Purge removes incoming/outgoing relation rows through the existing deletion path. Capture provenance and project-note relations remain independent.

“Linked from” is derived from the account's cached note documents, including optimistic saves, so it works offline and follows sync rollback, Trash, restore and purge. It includes archived sources and excludes trashed sources. Navigation through an inline link or incoming-link button first awaits durable draft storage. Failure keeps the editor open with an error. These links stay inside the app; they never navigate the editing WebView to a URL.

References deliberately contain no copied target title. Standalone plain-text derivation uses `[[Note]]`, and Markdown conversion preserves the identity as `[[note:UUID]]`; a future account export must resolve labels from the exported record set. Title search continues to match the target note itself. Task descriptions do not yet support note-reference nodes. This is an additive development schema change: update the API and mobile bundle together; older clients reject the new node instead of flattening it.

The three editor browser tests include picker selection, duplicate-title context, live rename, structured save, failed-storage navigation, incoming-link navigation and mobile overflow checks. Real-device IME, accessibility and SQLite/WebView bridge acceptance remain pending.

## Local Android setup

This machine's Android Studio Java 25 runtime failed native CMake configuration. Java 17 successfully built the development app. The installed toolchain is `D:/Android/gradle/jdks/eclipse_adoptium-17-amd64-windows.2`, with SDK in `%LOCALAPPDATA%/Android/Sdk` and Gradle cache in `D:/Android/gradle`. These are machine-specific paths, not application configuration.

For an emulator with adb port forwarding, Metro must listen on IPv4 localhost. If Node resolves localhost to `::1`, start Metro with `NODE_OPTIONS=--dns-result-order=ipv4first` and `pnpm dev:mobile -- --localhost`.
