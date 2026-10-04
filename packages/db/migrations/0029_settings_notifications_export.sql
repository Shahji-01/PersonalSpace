-- Migration 0029: User preferences, device tokens, notification logs, and export jobs
-- Covers §21 (Settings), §50 (Notification delivery), §20/64 (Export/Deletion)

BEGIN;

-- ============================================================
-- User preferences  (§21)
-- ============================================================
CREATE TABLE user_preferences (
  user_id        UUID PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  -- Regional
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locale         TEXT NOT NULL DEFAULT 'en-IN',
  week_start_day SMALLINT NOT NULL DEFAULT 1,  -- 1=Monday (ISO)
  base_currency  TEXT NOT NULL DEFAULT 'INR',
  -- Time / day-parts  (HH:MM wall times)
  morning_start  TIME NOT NULL DEFAULT '06:00',
  afternoon_start TIME NOT NULL DEFAULT '12:00',
  evening_start  TIME NOT NULL DEFAULT '17:00',
  night_start    TIME NOT NULL DEFAULT '21:00',
  -- Money defaults
  default_account_id UUID,
  default_payment_method TEXT,
  -- Capture
  capture_target TEXT NOT NULL DEFAULT 'inbox',  -- 'inbox' | 'note' | 'task'
  -- Notifications
  quiet_hours_start TIME NOT NULL DEFAULT '22:30',
  quiet_hours_end   TIME NOT NULL DEFAULT '07:00',
  notification_reminder  BOOLEAN NOT NULL DEFAULT TRUE,
  notification_task_due  BOOLEAN NOT NULL DEFAULT TRUE,
  notification_debt_due  BOOLEAN NOT NULL DEFAULT TRUE,
  notification_export    BOOLEAN NOT NULL DEFAULT TRUE,
  -- AI
  ai_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  ai_memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ai_conversation_retention_days INTEGER NOT NULL DEFAULT 90,
  -- Security
  app_lock_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  app_lock_timeout_minutes INTEGER NOT NULL DEFAULT 5,
  hide_in_switcher   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Privacy
  analytics_opt_out  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Appearance
  theme TEXT NOT NULL DEFAULT 'system',   -- 'system' | 'light' | 'dark'
  text_size TEXT NOT NULL DEFAULT 'system', -- 'system' | 'small' | 'medium' | 'large'
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_owner ON user_preferences
  USING (user_id = current_setting('app.user_id')::uuid);

-- ============================================================
-- Device tokens  (§50)
-- ============================================================
CREATE TABLE device_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  token       TEXT NOT NULL,
  device_name TEXT,
  app_version TEXT,
  -- Watermark: the latest reminder fire_at this device has scheduled locally
  reminders_scheduled_through TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);
CREATE INDEX idx_device_tokens_user ON device_tokens (user_id);
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_tokens_owner ON device_tokens
  USING (user_id = current_setting('app.user_id')::uuid);

-- ============================================================
-- Notification log  (§22, §50.3 idempotent delivery)
-- ============================================================
CREATE TABLE notification_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- 'reminder' | 'task_due' | 'debt_due' | 'export_ready' | ...
  dedupe_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  entity_id   UUID,
  -- Delivery
  channel     TEXT NOT NULL,   -- 'push' | 'local' | 'email'
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  sent_at     TIMESTAMPTZ,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_notification_log_user_created ON notification_log (user_id, created_at DESC);
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_log_owner ON notification_log
  USING (user_id = current_setting('app.user_id')::uuid);

-- ============================================================
-- Export jobs  (§20.1, §64.2)
-- ============================================================
CREATE TABLE export_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  format      TEXT NOT NULL,   -- 'json' | 'csv' | 'markdown'
  scope       TEXT NOT NULL DEFAULT 'everything',  -- 'everything' | 'notes' | 'tasks' | 'learning' | 'money'
  status      TEXT NOT NULL DEFAULT 'queued',       -- 'queued' | 'processing' | 'ready' | 'expired' | 'failed'
  -- Output
  storage_key TEXT,
  size_bytes  BIGINT,
  download_url_expires_at TIMESTAMPTZ,
  -- Progress
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_export_jobs_user ON export_jobs (user_id, created_at DESC);
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY export_jobs_owner ON export_jobs
  USING (user_id = current_setting('app.user_id')::uuid);

-- ============================================================
-- Account deletion requests  (§64.3)
-- ============================================================
CREATE TABLE deletion_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'cancelled'
  reason       TEXT,
  -- Grace period
  grace_ends_at TIMESTAMPTZ NOT NULL,
  -- Pipeline progress
  step         TEXT,
  steps_log    JSONB NOT NULL DEFAULT '[]',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_owner ON deletion_requests
  USING (user_id = current_setting('app.user_id')::uuid);

-- Grant app role access
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO personalspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO personalspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_log TO personalspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON export_jobs TO personalspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON deletion_requests TO personalspace_app;

COMMIT;
