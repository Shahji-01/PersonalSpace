# Verification — 29 September 2026

Validated locally on Windows with Node 24.13.1, pnpm 9.15.4, Docker Desktop, PostgreSQL 17, and Chrome.

| Check                                               | Result                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Workspace + test/tool TypeScript                    | Passed                                                                                                                           |
| ESLint                                              | Passed                                                                                                                           |
| Unit tests                                          | 14 passed: validation, note and task lifecycle commands, tag normalization, capture suggestions, sync replay and acknowledgement |
| PostgreSQL/API integration                          | 14 passed against an isolated Testcontainers database                                                                            |
| Browser tests                                       | 2 passed: desktop and 390px phone viewport                                                                                       |
| Web visual review                                   | Desktop and phone screenshots inspected; no horizontal overflow or browser errors                                                |
| API, worker, web builds                             | Passed                                                                                                                           |
| Android and iOS Hermes bundle exports               | Passed                                                                                                                           |
| Expo dependency compatibility                       | Passed after aligning safe-area-context with SDK 57                                                                              |
| Local migrations                                    | Applied successfully; repeated migration application covered by integration test                                                 |
| Local API readiness and web HTTP response           | 200 / ready                                                                                                                      |
| Live HTTP → DB → outbox → BullMQ → Redis → sign-out | Passed; temporary smoke account and jobs removed                                                                                 |

The integration suite exercises actual Better Auth signup/signin/signout, explicit origin checks, owner isolation for all nine product tables, no pooled-context leakage, separate auth/application privileges, strict input ownership, duplicate keys, simultaneous retries, stale version rejection, atomic conversion/provenance, rollback, append-only audit privileges, the full note lifecycle (edit, soft-delete to Trash, restore, and permanent purge with provenance-foreign-key cleanup under RLS), task rescheduling with one-level subtasks (parent linkage, nesting rejection, and subtask completion), task renaming with soft-delete/restore/purge including subtask cascade and purge-guard checks, and item tagging (server-side normalization, entity/type version parity, and clearing).

Browser screenshots are generated under ignored `test-results/`. Use `pnpm test:web` to recreate them after a web build. On this machine tests used the installed Chrome (`PLAYWRIGHT_CHANNEL=chrome`).

## Not verified or complete

- Native Android/iOS installation and device interaction tests. Android SDK/AVD files are present, but no emulator/device was connected during validation. iOS native builds require macOS or EAS.
- Durable mobile storage under app-kill/restart, OS secure-store behavior, keyboard/accessibility, and offline mode on real devices. The sync algorithm is tested; native acceptance remains open.
- Remote CI execution, staging/production, OAuth/email providers, store submission, discovery, legal review, security/load testing, and all later modules listed in `implementation.md`.

Windows sandbox execution blocked esbuild/Hermes/browser subprocesses and Docker access; those checks were rerun successfully with approved execution permissions. No sandbox workaround was added to application code.
