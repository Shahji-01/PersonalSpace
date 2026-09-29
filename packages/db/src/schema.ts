import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  date,
  jsonb,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const authUsers = pgTable('auth_user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  ageConfirmed: boolean('age_confirmed').notNull(),
  termsAccepted: boolean('terms_accepted').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});
export const authSessions = pgTable('auth_session', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});
export const authAccounts = pgTable(
  'auth_account',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    scope: text('scope'),
    accessTokenExpiresAt: instant('access_token_expires_at'),
    refreshTokenExpiresAt: instant('refresh_token_expires_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.providerId, t.accountId)],
);
export const authVerifications = pgTable('auth_verification', {
  id: uuid('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: instant('expires_at').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});
const std = () => ({
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
  version: bigint('version', { mode: 'number' }).notNull(),
});
export const syncState = pgTable('user_sync_state', {
  userId: uuid('user_id').primaryKey(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
});
export const entities = pgTable(
  'entities',
  {
    ...std(),
    type: text('type').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [unique().on(t.id, t.userId), index().on(t.userId, t.version)],
);
export const inboxItems = pgTable(
  'inbox_items',
  {
    ...std(),
    rawText: text('raw_text').notNull(),
    status: text('status').notNull().default('new'),
    convertedEntityId: uuid('converted_entity_id'),
  },
  (t) => [index().on(t.userId, t.version)],
);
export const tasks = pgTable(
  'tasks',
  {
    ...std(),
    title: text('title').notNull(),
    status: text('status').notNull().default('todo'),
    plannedDate: date('planned_date'),
    completedAt: instant('completed_at'),
    parentId: uuid('parent_id'),
  },
  (t) => [index().on(t.userId, t.version), index().on(t.userId, t.parentId)],
);
export const notes = pgTable(
  'notes',
  {
    ...std(),
    title: text('title').notNull(),
    contentJson: jsonb('content_json').notNull(),
    contentText: text('content_text').notNull(),
  },
  (t) => [index().on(t.userId, t.version)],
);
export const entityLinks = pgTable('entity_links', {
  ...std(),
  sourceId: uuid('source_id').notNull(),
  targetId: uuid('target_id').notNull(),
  relation: text('relation').notNull(),
});
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: uuid('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  processedAt: instant('processed_at'),
});
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  action: text('action').notNull(),
  entityId: uuid('entity_id').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
});
