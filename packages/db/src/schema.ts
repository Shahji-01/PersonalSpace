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
  integer,
  smallint,
  customType,
  time,
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
    purgedAt: instant('purged_at'),
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
    priority: smallint('priority').notNull().default(0),
    plannedDate: date('planned_date'),
    dueDate: date('due_date'),
    dueTime: time('due_time'),
    timeMode: text('time_mode').notNull().default('floating'),
    timezone: text('timezone'),
    dueAt: instant('due_at'),
    completedAt: instant('completed_at'),
    parentId: uuid('parent_id'),
    projectId: uuid('project_id'),
    descriptionJson: jsonb('description_json'),
    descriptionSchemaVersion: integer('description_schema_version').notNull().default(1),
    descriptionText: text('description_text').notNull().default(''),
    estimatedMinutes: integer('estimated_minutes'),
    archivedAt: instant('archived_at'),
    recurrenceRuleId: uuid('recurrence_rule_id'),
    recurrenceSeriesId: uuid('recurrence_series_id'),
    occurrenceDate: date('occurrence_date'),
    occurrenceNumber: integer('occurrence_number'),
    nextTaskId: uuid('next_task_id'),
    recurrenceAdvanced: boolean('recurrence_advanced').notNull().default(false),
  },
  (t) => [
    index().on(t.userId, t.version),
    index().on(t.userId, t.parentId),
    index().on(t.userId, t.status, t.dueDate),
  ],
);
export const recurrenceRules = pgTable(
  'recurrence_rules',
  {
    ...std(),
    rrule: text('rrule').notNull(),
    settings: jsonb('settings').notNull(),
    template: jsonb('template').notNull(),
    endedAt: instant('ended_at'),
  },
  (t) => [unique().on(t.id, t.userId)],
);
export const notes = pgTable(
  'notes',
  {
    ...std(),
    title: text('title').notNull(),
    contentJson: jsonb('content_json').notNull(),
    contentSchemaVersion: integer('content_schema_version').notNull().default(1),
    recoveredFromId: uuid('recovered_from_id'),
    contentText: text('content_text').notNull(),
    isPinned: boolean('is_pinned').notNull().default(false),
    isFavorite: boolean('is_favorite').notNull().default(false),
    archivedAt: instant('archived_at'),
    folderId: uuid('folder_id'),
    kind: text('kind').notNull().default('note'),
    dailyDate: date('daily_date'),
  },
  (t) => [index().on(t.userId, t.version)],
);
export const noteFolders = pgTable(
  'note_folders',
  {
    ...std(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
  },
  (t) => [unique().on(t.id, t.userId), index().on(t.userId, t.parentId)],
);
export const projects = pgTable(
  'projects',
  {
    ...std(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    status: text('status').notNull().default('active'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [unique().on(t.id, t.userId), index().on(t.userId, t.status, t.sortOrder)],
);
export const entityLinks = pgTable('entity_links', {
  ...std(),
  sourceId: uuid('source_id').notNull(),
  targetId: uuid('target_id').notNull(),
  relation: text('relation').notNull(),
});
export const noteVersions = pgTable(
  'note_versions',
  {
    id: uuid('id').primaryKey(),
    noteId: uuid('note_id').notNull(),
    userId: uuid('user_id').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    contentJson: jsonb('content_json').notNull(),
    contentSchemaVersion: integer('content_schema_version').notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
    reason: text('reason').notNull(),
  },
  (t) => [unique().on(t.noteId, t.version), index().on(t.userId, t.noteId, t.version)],
);
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
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
export const searchDocuments = pgTable('search_documents', {
  entityId: uuid('entity_id').primaryKey(),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  extra: text('extra').notNull(),
  titleNormalized: text('title_normalized').notNull(),
  document: tsvector('document').notNull(),
  status: text('status').notNull(),
  archived: boolean('archived').notNull().default(false),
  projectId: uuid('project_id'),
  folderId: uuid('folder_id'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});
