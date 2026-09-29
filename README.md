# PersonalSpace

A mobile-first personal space for life, learning, work, and money. Product source of truth: [Specification v1.2](PersonalSpace-Specification-v1.2.md).

**Status: Phase 0 in progress.** This repository now contains a working development slice for accounts, quick capture, inbox filing, plain-text notes, tasks, and incremental sync. It is not the completed v1.0 product. Use synthetic data until the privacy, account-lifecycle, and security launch requirements are complete.

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

The mobile app uses an Expo **development build**. From `apps/mobile`, run `pnpm android` on a machine with the Android toolchain; use `pnpm ios` on macOS, or EAS development builds. `pnpm dev:mobile` then starts Metro for the installed development client. Native widgets/share extensions are not implemented yet.

For a physical phone, set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your computer's LAN address, set `HOST=0.0.0.0` and the same `API_URL` in root `.env`, then restart Metro and the API. Android emulators normally reach the host through `10.0.2.2`. Use HTTPS for a remote API; cleartext development connections depend on native platform configuration.

## Try the first slice

1. Create a test account in the mobile app, confirming 18+ and development-preview use.
2. Open Capture. Save to Inbox, Note, or Task for today.
3. Find a task in Today and mark it complete; reopen it if needed.
4. In Library → Inbox, file a synced capture as a task or note. The original capture remains linked on the server.
5. Disable connectivity and capture another item. It persists in SQLite with pending status. Reconnect or pull to refresh to sync.
6. Sign in on another device to retrieve the same account's records. A different account cannot see them.

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
pnpm --filter @personalspace/mobile bundle
```

The integration suite needs Docker. It creates and removes an isolated PostgreSQL container, uses non-owner database roles, and checks authentication, RLS, cross-account access, idempotency, concurrent retries, conversion provenance, atomic rollback, and session revocation. Native bundle export does **not** replace emulator/device E2E testing.

With the API, database, Redis, and worker running, `pnpm exec tsx --env-file=.env scripts/smoke.ts` verifies a real HTTP capture reaches the outbox, BullMQ, and Redis. It creates and removes only its own synthetic local fixture. Browser checks can use an installed Chrome with `PLAYWRIGHT_CHANNEL=chrome` instead of downloading Chromium.

CI is defined in `.github/workflows/ci.yml`. No remote repository or deployment has been configured.

See [implementation status and remaining milestones](docs/implementation.md) for the build sequence and explicit gaps. The original specification is unchanged.
