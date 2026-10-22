## Purpose

Help users find their own saved information consistently across local and server search without leaking deleted, stale or foreign-account data.

## ADDED Requirements

### Requirement: Search covers the v1 modules with usable filters

Keyword search SHALL cover the specified notes, tasks, reminders, learning and money fields, support module/date/tag filters and stable pagination, and open the selected record. Server typo tolerance and local full-text behavior SHALL follow the product search policy; pending local records SHALL remain discoverable.

#### Scenario: Search an unsynced note offline

- **WHEN** a user searches for text in a locally saved pending note
- **THEN** the note appears with its pending state and opens without network access

#### Scenario: Paginate while indexing advances

- **WHEN** a user loads another page while background index updates occur
- **THEN** pagination follows its documented ordering/cursor semantics without cross-account results or silent repeated-page loops

### Requirement: Transliteration and relevance have regression evidence

Local and server search SHALL support the specified transliteration mappings and preserve original display text. A shared relevance corpus SHALL test representative exact, prefix, typo and transliterated queries, documenting intentional local/server differences.

#### Scenario: Query uses a transliterated term

- **WHEN** a fixture query matches a supported alternate-script representation
- **THEN** the intended record is discoverable offline and online with its original text displayed

### Requirement: Search reflects access and lifecycle changes

Index updates SHALL track edits, archive/Trash filters, purge and account erasure. Foreign-account content SHALL never appear in results, counts or suggestions. A stale result SHALL not bypass current authorization when opened.

#### Scenario: Record deleted after search

- **WHEN** a user opens a result that has since been purged
- **THEN** the UI shows an unavailable state without restoring or exposing deleted content

#### Scenario: Account switched during a query

- **WHEN** a response arrives after the user switches accounts
- **THEN** that response is discarded from the new account's search view
