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
// Signing keys for the Better Auth JWT plugin (short-lived access tokens, ADR-013).
export const authJwks = pgTable('jwks', {
  id: uuid('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  expiresAt: instant('expires_at'),
  alg: text('alg'),
  crv: text('crv'),
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
export const reminders = pgTable(
  'reminders',
  {
    ...std(),
    entityId: uuid('entity_id'),
    title: text('title').notNull(),
    remindDate: date('remind_date').notNull(),
    remindTime: time('remind_time').notNull(),
    timeMode: text('time_mode').notNull().default('floating'),
    timezone: text('timezone').notNull(),
    fireAt: instant('fire_at').notNull(),
    status: text('status').notNull().default('scheduled'),
    snoozedUntil: instant('snoozed_until'),
    lastFiredAt: instant('last_fired_at'),
    recurrenceRuleId: uuid('recurrence_rule_id'),
  },
  (t) => [
    index().on(t.userId, t.version),
    index('reminders_fire_at').on(t.fireAt),
    index('reminders_user_entity').on(t.userId, t.entityId),
  ],
);
export const learningCollections = pgTable(
  'learning_collections',
  {
    ...std(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index().on(t.userId, t.parentId)],
);
export const learningResources = pgTable(
  'learning_resources',
  {
    ...std(),
    collectionId: uuid('collection_id'),
    url: text('url'),
    canonicalUrl: text('canonical_url'),
    urlHash: text('url_hash'),
    resourceType: text('resource_type').notNull(),
    source: text('source').notNull().default('manual'),
    externalId: text('external_id'),
    parentResourceId: uuid('parent_resource_id'),
    positionInParent: integer('position_in_parent'),
    title: text('title').notNull(),
    author: text('author'),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    durationSeconds: integer('duration_seconds'),
    status: text('status').notNull().default('saved'),
    progressPercent: smallint('progress_percent').notNull().default(0),
    progressSeconds: integer('progress_seconds'),
    progressMode: text('progress_mode').notNull().default('manual'),
    metadataStatus: text('metadata_status').notNull().default('pending'),
    metadataFetchedAt: instant('metadata_fetched_at'),
    lastOpenedAt: instant('last_opened_at'),
    completedAt: instant('completed_at'),
  },
  (t) => [
    index().on(t.userId, t.version),
    index('learning_resources_user_collection').on(t.userId, t.collectionId),
    index('learning_resources_user_status').on(t.userId, t.status),
    index('learning_resources_parent').on(t.userId, t.parentResourceId),
  ],
);
export const people = pgTable(
  'people',
  {
    ...std(),
    name: text('name').notNull(),
    nickname: text('nickname'),
    note: text('note'),
  },
  (t) => [index().on(t.userId)],
);
export const financeAccounts = pgTable(
  'finance_accounts',
  {
    ...std(),
    name: text('name').notNull(),
    accountType: text('account_type').notNull(),
    isLiability: boolean('is_liability').notNull().default(false),
    currency: text('currency').notNull().default('INR'),
    openingBalanceMinor: bigint('opening_balance_minor', { mode: 'number' }).notNull().default(0),
    openingDate: date('opening_date').notNull(),
    labelLast4: text('label_last4'),
    sortOrder: integer('sort_order').notNull().default(0),
    cachedBalanceMinor: bigint('cached_balance_minor', { mode: 'number' }).notNull().default(0),
    cachedBalanceVersion: bigint('cached_balance_version', { mode: 'number' }).notNull().default(0),
    archivedAt: instant('archived_at'),
  },
  (t) => [index().on(t.userId)],
);
export const financeCategories = pgTable(
  'finance_categories',
  {
    ...std(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    icon: text('icon'),
    color: text('color'),
    isSystemSeed: boolean('is_system_seed').notNull().default(false),
    archivedAt: instant('archived_at'),
  },
  (t) => [index().on(t.userId, t.kind)],
);
export const debts = pgTable(
  'debts',
  {
    ...std(),
    personId: uuid('person_id').notNull(),
    direction: text('direction').notNull(),
    currency: text('currency').notNull().default('INR'),
    title: text('title'),
    openedOn: date('opened_on').notNull(),
    dueOn: date('due_on'),
    manualStatus: text('manual_status').notNull().default('open'),
    isRunningLedger: boolean('is_running_ledger').notNull().default(true),
    cachedOutstandingMinor: bigint('cached_outstanding_minor', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (t) => [index().on(t.userId, t.personId)],
);
export const financeTransactions = pgTable(
  'finance_transactions',
  {
    ...std(),
    transactionType: text('transaction_type').notNull(),
    status: text('status').notNull().default('posted'),
    accountId: uuid('account_id').notNull(),
    toAccountId: uuid('to_account_id'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('INR'),
    toAmountMinor: bigint('to_amount_minor', { mode: 'number' }),
    adjustmentSign: smallint('adjustment_sign'),
    transactionDate: date('transaction_date').notNull(),
    occurredAt: instant('occurred_at'),
    description: text('description'),
    merchant: text('merchant'),
    paymentMethod: text('payment_method'),
    personId: uuid('person_id'),
    debtId: uuid('debt_id'),
    source: text('source').notNull().default('app'),
  },
  (t) => [
    index().on(t.userId, t.version),
    index('finance_tx_user_date').on(t.userId, t.transactionDate),
    index('finance_tx_user_account').on(t.userId, t.accountId, t.transactionDate),
  ],
);
export const transactionSplits = pgTable(
  'transaction_splits',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    transactionId: uuid('transaction_id').notNull(),
    kind: text('kind').notNull(),
    categoryId: uuid('category_id'),
    personId: uuid('person_id'),
    debtId: uuid('debt_id'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    note: text('note'),
  },
  (t) => [index().on(t.transactionId)],
);
export const transactionRevisions = pgTable(
  'transaction_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    transactionId: uuid('transaction_id').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    changedBy: text('changed_by').notNull(),
    reason: text('reason'),
    requestId: text('request_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index().on(t.transactionId, t.createdAt)],
);
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

export const attachments = pgTable(
  'attachments',
  {
    ...std(),
    parentId: uuid('parent_id').notNull(),
    filename: text('filename').notNull(),
    declaredMime: text('declared_mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('pending'),
    storageKey: text('storage_key').notNull().unique(),
    uploadId: text('upload_id'),
    sessionId: uuid('session_id').notNull().defaultRandom(),
    processedKey: text('processed_key'),
    thumbnailKey: text('thumbnail_key'),
    processedMime: text('processed_mime'),
    processedSize: integer('processed_size'),
    thumbnailSize: integer('thumbnail_size').notNull().default(0),
    processedSha256: text('processed_sha256'),
    rejectionReason: text('rejection_reason'),
    processingToken: uuid('processing_token'),
    processingLeaseUntil: instant('processing_lease_until'),
  },
  (table) => [index().on(table.userId, table.parentId), index().on(table.userId, table.version)],
);

// ============================================================
// User Preferences (§21)
// ============================================================
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id').primaryKey(),
  // Regional
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  locale: text('locale').notNull().default('en-IN'),
  weekStartDay: smallint('week_start_day').notNull().default(1),
  baseCurrency: text('base_currency').notNull().default('INR'),
  // Time / day-parts
  morningStart: time('morning_start').notNull().default('06:00'),
  afternoonStart: time('afternoon_start').notNull().default('12:00'),
  eveningStart: time('evening_start').notNull().default('17:00'),
  nightStart: time('night_start').notNull().default('21:00'),
  // Money defaults
  defaultAccountId: uuid('default_account_id'),
  defaultPaymentMethod: text('default_payment_method'),
  // Capture
  captureTarget: text('capture_target').notNull().default('inbox'),
  // Notifications
  quietHoursStart: time('quiet_hours_start').notNull().default('22:30'),
  quietHoursEnd: time('quiet_hours_end').notNull().default('07:00'),
  notificationReminder: boolean('notification_reminder').notNull().default(true),
  notificationTaskDue: boolean('notification_task_due').notNull().default(true),
  notificationDebtDue: boolean('notification_debt_due').notNull().default(true),
  notificationExport: boolean('notification_export').notNull().default(true),
  // AI
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  aiMemoryEnabled: boolean('ai_memory_enabled').notNull().default(true),
  aiConversationRetentionDays: integer('ai_conversation_retention_days').notNull().default(90),
  // Security
  appLockEnabled: boolean('app_lock_enabled').notNull().default(false),
  appLockTimeoutMinutes: integer('app_lock_timeout_minutes').notNull().default(5),
  hideInSwitcher: boolean('hide_in_switcher').notNull().default(false),
  // Privacy
  analyticsOptOut: boolean('analytics_opt_out').notNull().default(false),
  // Appearance
  theme: text('theme').notNull().default('system'),
  textSize: text('text_size').notNull().default('system'),
  // Timestamps
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

// ============================================================
// Device Tokens (§50)
// ============================================================
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    platform: text('platform').notNull(),
    token: text('token').notNull(),
    deviceName: text('device_name'),
    appVersion: text('app_version'),
    remindersScheduledThrough: instant('reminders_scheduled_through'),
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.token), index().on(t.userId)],
);

// ============================================================
// Notification Log (§22, §50.3)
// ============================================================
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    entityId: uuid('entity_id'),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    sentAt: instant('sent_at'),
    error: text('error'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.dedupeKey), index().on(t.userId, t.createdAt)],
);

// ============================================================
// Export Jobs (§20.1, §64.2)
// ============================================================
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    format: text('format').notNull(),
    scope: text('scope').notNull().default('everything'),
    status: text('status').notNull().default('queued'),
    storageKey: text('storage_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    downloadUrlExpiresAt: instant('download_url_expires_at'),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    error: text('error'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

// ============================================================
// Account Deletion Requests (§64.3)
// ============================================================
export const deletionRequests = pgTable('deletion_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique(),
  status: text('status').notNull().default('pending'),
  reason: text('reason'),
  graceEndsAt: instant('grace_ends_at').notNull(),
  step: text('step'),
  stepsLog: jsonb('steps_log').notNull().default([]),
  startedAt: instant('started_at'),
  completedAt: instant('completed_at'),
  cancelledAt: instant('cancelled_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
});
