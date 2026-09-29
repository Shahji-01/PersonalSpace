# ADR-001 — Implement the specified modular monolith

Status: Accepted, carried forward from specification v1.2 (ADR-001–007, 009, 012, 018, 021).

Use TypeScript/pnpm/Turborepo, Expo mobile, Next.js web shell, Fastify, PostgreSQL/Drizzle, Redis/BullMQ. Keep domain writes behind one service boundary shared by REST and future AI tools. Treat sync writes as domain commands.

Database connections have separate privileges: migrations own tables, Better Auth owns access to auth tables, the application uses forced RLS, and the worker can only read/update the metadata outbox. No application process uses the migration owner's credentials.

Authentication tables intentionally use the library's schema and physical `auth_*` names. Product entities use UUIDv7 with composite owner foreign keys. Application data is not end-to-end encrypted.
