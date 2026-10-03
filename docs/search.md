# Search implementation

Search covers notes (content), tasks (title and rich description), projects (name), Inbox (raw text), and their tags. Folders are filters. Later domains and attachments will join when their storage and lifecycles exist.

## Server

`GET /api/v1/search?q=...` requires the same bearer authentication as other product routes. Optional filters: `type`, `tag`, `status`, `projectId`, `folderId`, `from`, `to`, `includeArchived`. Dates are inclusive UTC creation dates. Trash, purged entities and converted Inbox items are excluded. Archived notes/tasks/projects require `includeArchived=true`.

Each type returns a group with `records` and `hasMore`. The default is three per type; `limit` accepts 1–50 and `offset` 0–10000. The mobile type view uses pages of 20. Queries accept at most 200 characters and use the first 20 word tokens. User input cannot supply SQL or full-text operators. Empty/punctuation-only queries return no groups.

`search_documents` has owner RLS and a composite entity/owner foreign key. Migration 0016 backfills existing content. The domain command transaction replaces the affected index rows after producing authoritative records; soft deletion, conversion and purge remove searchable content in the same commit. Search results never include drafts or note-history snapshots.

Weighted `simple`/`unaccent` vectors provide prefix matching; title trigrams provide online typo matching. Ranking includes text rank, title similarity, recency and an open-task boost. This follows PostgreSQL's [text-search controls](https://www.postgresql.org/docs/17/textsearch-controls.html) and [pg_trgm documentation](https://www.postgresql.org/docs/17/pgtrgm.html). English and Devanagari terms are tested; cross-script transliteration remains unimplemented.

## Mobile

The account-scoped SQLite cache has an FTS5 table maintained by record insert/update/delete triggers. Existing cached records are indexed once. The tokenizer preserves Unicode combining marks and handles Latin accents. Queries are quoted word prefixes, and all lookups filter by account. The implementation uses the documented [FTS5 query/tokenizer behavior](https://www.sqlite.org/fts5.html); [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) enables FTS by default.

The screen displays local matches first and merges online results after a short debounce. Older requests cannot replace the current query. Online results are cached without changing the sync cursor. Pending edits, newer cached versions and permanent-purge markers take priority over remote search responses. Offline search supports prefix matching; typo matching is server-side.

Filters apply to both local and online queries. Live edits may change result ordering while paging. Search does not store a query history. API logs record the route template instead of private query strings.

## Acceptance still required

Real-device FTS/keyboard/accessibility checks, large-account relevance and latency testing, complete multilingual transliteration and later-module indexing remain open. Node's real SQLite engine validates queries, triggers, upgrade backfill, account boundaries and deletion behavior; it does not replace testing the native Expo bridge. The emulator has not been controlled during this implementation.
