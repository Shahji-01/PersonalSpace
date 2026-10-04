# PersonalSpace

A mobile-first personal space for life, learning, work, and money. Product source of truth: [Specification v1.2](PersonalSpace-Specification-v1.2.md).

**Status: Phase 0 / M1 in progress.** This repository contains a working development slice for accounts, quick capture, inbox filing, rich-text and daily notes, folders, note history, projects, tasks with rich descriptions/estimates/archive, unified search, reviewed capture dates, and incremental sync. It is not the completed v1.0 product. Use synthetic data until the privacy, account-lifecycle, and security launch requirements are complete. See the [whole-project audit](docs/project-audit.md) for coverage and the remaining build order.

## Run locally

Requirements: Node.js 22.13+ (24 recommended), pnpm 9.15.4, Docker Desktop with Linux containers. Android native builds additionally need Android Studio/JDK; local iOS builds require macOS/Xcode, or an EAS account for cloud builds.

```sh
pnpm install
node scripts/setup.mjs
pnpm infra:up
pnpm db:migrate
```

Start these in separate terminals:

```sh
pnpm dev:api
pnpm dev:web
pnpm --filter @personalspace/worker dev
pnpm dev:mobile
```

- Web shell: http://localhost:3000
- API liveness: http://localhost:4000/health
- API dependency readiness: http://localhost:4000/ready
- OpenAPI document: http://localhost:4000/openapi.json
- PostgreSQL: port 5432; Redis: port 6379; both bound to loopback by Compose.

The setup script generates an ignored `.env` with a random auth secret and preserves existing configuration. The passwords in Compose and `.env.example` are **local-only**. Keep the migration owner connection out of API/worker configuration in deployment.

Database roles are least-privileged: `personalspace_app` (API, per-user RLS), `personalspace_auth` (auth tables), `personalspace_worker` (sync relay — outbox metadata only) and `personalspace_maintenance` (cross-user nightly cleanup/reconciliation). The maintenance role is provisioned in `infra/postgres/init.sql`; set `MAINTENANCE_DATABASE_URL` for the worker. An existing local database created before this role was added needs it created once (re-run `init.sql` or `CREATE ROLE personalspace_maintenance …`) before `pnpm db:migrate`.

The mobile app uses an Expo **development build**. From `apps/mobile`, run `pnpm android` on a machine with the Android toolchain; use `pnpm ios` on macOS, or EAS development builds. `pnpm dev:mobile` then starts Metro for the installed development client. Native widgets/share extensions are not implemented yet.

For a physical phone, set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your computer's LAN address, set `HOST=0.0.0.0` and the same `API_URL` in root `.env`, then restart Metro and the API. Android emulators normally reach the host through `10.0.2.2`. Use HTTPS for a remote API; cleartext development connections depend on native platform configuration.

## Try the first slice

1. Create a test account in the mobile app, confirming 18+ and development-preview use.
2. Open Capture. Save to Inbox, Note, or Task for today.
3. Find a task in Today and mark it complete; reopen it if needed.
4. In Library → Inbox, file a synced capture as a task or note. The original capture remains linked on the server.
5. Disable connectivity and capture another item. It persists in SQLite with pending status. Reconnect or pull to refresh to sync.
6. Sign in on another device to retrieve the same account's records. A different account cannot see them.
7. In Library → Notes, use Manage folders to organize notes up to three levels deep. A note's Folder control files it; Version history previews and restores earlier saved content. Previously loaded history is available offline.
8. Permanently deleting a trashed item removes it on other devices when they next sync. Empty folders can be deleted from Manage folders.
9. In the task view, use Manage projects to create, color, order or archive projects, then assign tasks. Explore Next 7/30 days, Overdue and Completed; these views work from the local cache.
10. Open task Details to give a deadline an optional time. Local time follows your current timezone; Fixed timezone keeps the same instant when you travel. Repeated clock times require choosing an occurrence.
11. Open a project's Related notes to link, unlink or open notes. Links survive Trash/restore and are removed when the note is permanently deleted.
12. In a note, type `[[` or tap Link note to choose another synced note. Open its link to navigate; your current draft is saved first. The target note shows incoming links under Linked from.
13. Task Details → Repeat supports fixed and after-completion schedules, weekday/month-end choices and finite series. Complete or skip an occurrence, then sync to see its successor. Edits ask whether to affect this occurrence or future ones too.
14. Changed notes receive history checkpoints every ten minutes and when closing. Save changes publishes the note; Version history can recover synced unfinished edits. Discarding a local draft preserves its queued/synced history.
15. If a note draft conflicts with a newer version, use Review draft → Save as separate note. The copy keeps its formatting and links back to the original; your draft is retained until the copy syncs. Expired sync cursors recover automatically without clearing queued captures.

Creates work offline. Completion and conversion require the source item to have synced once. Failed changes are shown explicitly; local captures are not silently discarded. Signing out preserves that account's unsynced data on the device. Offline sign-out clears the local credential; server revocation requires connectivity.

## Repository

| Path                  | Responsibility                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| `apps/mobile`         | Expo app, secure credential storage, account-scoped SQLite cache/outbox |
| `apps/web`            | Next.js landing page and clearly marked legal drafts                    |
| `apps/api`            | Fastify HTTP API, Better Auth integration, OpenAPI                      |
| `apps/worker`         | Transactional outbox relay, BullMQ, Redis sync-watermark consumer       |
| `packages/db`         | Drizzle tables, PostgreSQL roles/RLS, checksummed SQL migrations        |
| `packages/domain`     | Capture and state-transition business rules                             |
| `packages/validation` | Shared strict Zod command and response contracts                        |
| `packages/api-client` | Typed, runtime-validated native API client                              |
| `packages/sync`       | Transport-independent replay/acknowledgement engine                     |
| `packages/nlp`        | Initial deterministic task suggestion rules                             |
| `packages/ui`         | Shared colors and spacing                                               |
| `packages/config`     | Environment validation and production launch gate                       |
| `tests`               | Real PostgreSQL integration tests via Testcontainers                    |

## Verify

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec playwright install chromium
pnpm test:web
pnpm test:editor
pnpm --filter @personalspace/mobile bundle
```

The integration suite needs Docker. It creates and removes an isolated PostgreSQL container, uses non-owner database roles, and checks authentication, RLS, cross-account access, idempotency, concurrent retries, conversion provenance, atomic rollback, and session revocation. Native bundle export does **not** replace emulator/device E2E testing.

With the API, database, Redis, and worker running, `pnpm exec tsx --env-file=.env scripts/smoke.ts` verifies a real HTTP capture reaches the outbox, BullMQ, and Redis. It creates and removes only its own synthetic local fixture. Browser checks can use an installed Chrome with `PLAYWRIGHT_CHANNEL=chrome` instead of downloading Chromium.

CI is defined in `.github/workflows/ci.yml`. The GitHub remote is `Shahji-01/PersonalSpace`; no production deployment has been configured.

See [implementation status and remaining milestones](docs/implementation.md) for the build sequence and explicit gaps. The original specification is unchanged.
