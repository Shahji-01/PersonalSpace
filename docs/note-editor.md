# Note editor

Notes use the shared `packages/editor-schema` v1 ProseMirror document format. The existing paragraph-only documents already conform to v1; migration 0006 adds an explicit schema version without rewriting content. Unknown future versions fail validation rather than losing formatting.

Mobile Quick Capture remains a fast plain-text input. Editing a synced note opens a bundled Tiptap editor in an Expo DOM component. The editor supports headings (levels 1–3), bold, italic, bullet/numbered lists, checklists, blockquotes, links, inline code, code blocks, and undo/redo. Library previews use native views. Editor assets are included in Android/iOS exports and do not use a CDN.

`note.updateContent` accepts validated JSON and the record's base version. The server derives the title and searchable text, then commits the note, entity version, audit event, and outbox event in the existing transaction. Sync carries both the canonical document and plain text. The legacy `note.edit` command continues to work for paragraph-only notes but rejects formatted notes to prevent accidental flattening.

The shared schema rejects unknown nodes/attributes, unsafe link protocols, more than 100,000 text characters, more than 10,000 nodes, or nesting deeper than 16. HTML pasted into the editor is interpreted by the configured Tiptap schema; the API accepts structured JSON, not arbitrary HTML. Links do not navigate the editing WebView. Markdown conversion is available in the shared package; a user-facing export flow is still pending.

Every valid editor change is queued to account-scoped SQLite draft storage. “Draft saved on this device” is shown only after that write succeeds. Close preserves the draft; Discard draft requires confirmation. Save changes also preserves the draft while its mutation is pending. Acknowledgement clears only the exact document/base-version pair that was accepted. Conflicts retain the local draft and restore the accepted record; a draft based on an older version must be reconciled rather than silently overwriting the newer note. Permanent note purge also removes its local draft after acknowledgement.

## Acceptance still required

The implementation does not decide ADR-027. Run the specification's editor spike on a 3–4 GB Android phone and an older supported iPhone: 5,000-word notes editable within 500 ms, keystrokes within 50 ms, Hindi/English Gboard and SwiftKey composition, caret/keyboard scrolling, app-kill recovery offline, TalkBack and VoiceOver. Automated schema, SQLite, API tests and emulator checks do not replace those measurements.

Attachments/images, backlinks, note history, and cross-device draft merging are separate unfinished features.

## Local Android setup

This machine's Android Studio Java 25 runtime failed native CMake configuration. Java 17 successfully built the development app. The installed toolchain is `D:/Android/gradle/jdks/eclipse_adoptium-17-amd64-windows.2`, with SDK in `%LOCALAPPDATA%/Android/Sdk` and Gradle cache in `D:/Android/gradle`. These are machine-specific paths, not application configuration.

For an emulator with adb port forwarding, Metro must listen on IPv4 localhost. If Node resolves localhost to `::1`, start Metro with `NODE_OPTIONS=--dns-result-order=ipv4first` and `pnpm dev:mobile -- --localhost`.
