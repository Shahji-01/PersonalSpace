# Nightly maintenance

Apply migration **0043** before running the updated worker. It adds retention indexes and column-level permissions for sync/audit bookkeeping, and removes the maintenance role's ability to update financial account balances. No authentication privileges are added. Migration and runtime validation in this increment use isolated databases; the running development services are not restarted.

The worker registers the `nightly` job (`0 2 * * *`) during its active loop. Registration retries approximately once per minute after failure, independently of deletion schedule registration. Its existing BullMQ repeat identity is preserved, so concurrent starts and older installations deduplicate. Unrelated repeat jobs do not suppress registration. Each scheduled job has three attempts with exponential backoff; failed jobs remain available for inspection. Loss of the Redis dataset after successful registration still requires a worker restart to reinstall these schedules.

## Content retention

Each pass selects at most 500 expired Trash entries: notes, tasks, unfiled inbox captures, reminders and Learning resources. It uses `deleted_at`, not `purged_at`. Financial rows and containers retain their explicit deletion workflows. Live and recently trashed records are excluded. Parent tasks wait for their children; eligible children are visited before parents so large families cannot stall pagination. A large backlog can take multiple nightly passes. Attachment and affected-reference fanout can exceed the 500 primary-record limit.

For each account, cleanup locks the same sync-state row as interactive mutations and rechecks eligibility after acquiring it. A restore that committed first is preserved. Concurrent cleanup attempts serialize. Accounts whose erasure already started are excluded; the database deletion fence also rejects writes if erasure starts during a pass.

The shared purge operation removes private content, note history, unused recurrence rules, search entries, links and attachment metadata. It scrubs removed records from cached command responses. Attachment removal requests are saved in the same transaction, with the existing ten-minute delay for outstanding grants; the attachment worker performs physical storage cleanup with retries. Unavailable storage delays byte erasure without losing its cleanup request.

The transaction reserves minimal entity deletion markers, increments the account sync version, updates affected project/inbox references, and records audit and sync-outbox events. Failure rolls back all of that account's changes. Earlier accounts in the pass may already have committed; retrying is safe.

## Offline recovery and retry retention

Physical deletion of UUID reservations has been removed from nightly maintenance. Incremental sync still expires deletion markers after 180 days and requests full recovery for stale cursors. Full recovery includes retained markers so old devices erase their local copies. Reservations prevent UUID reuse.

After seven days, cached command responses are compacted to empty arrays in batches of 500. The user ID, key, request hash and creation time remain. An identical late retry receives an empty acknowledgement and obtains current data through sync; a different command using the same key remains rejected. This deliberately retains deduplication metadata beyond the specification's seven-day key window: removing it without an expired-operation protocol could replay offline financial actions. Account deletion erases these reservations. Physical reservation compaction remains future protocol work.

## Reconciliation and failures

Balance reconciliation reads the ledger and cached balances in one SQL statement and reports drift. It does not repair balances: the former unlocked update could overwrite concurrent changes and bypass sync. Any repair must use a separate audited, versioned operation. The maintenance role is denied account UPDATE permission.

Operational logs contain event names and counts, not account identifiers, financial values or raw database errors. Independent maintenance steps continue after a failure; the queue attempt then fails with a generic error so BullMQ retries. External alert delivery and an operator repair workflow remain open.

The metadata, reminder and email schedulers are still separate pending work. In particular, registering email delivery before repairing its console fallback, claims and retry behavior would activate known privacy/reliability defects. Real server push transport is also still absent.
