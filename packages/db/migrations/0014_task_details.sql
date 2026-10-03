ALTER TABLE tasks
  ADD COLUMN description_json jsonb,
  ADD COLUMN description_schema_version integer NOT NULL DEFAULT 1 CHECK (description_schema_version = 1),
  ADD COLUMN description_text text NOT NULL DEFAULT '',
  ADD COLUMN estimated_minutes integer CHECK (estimated_minutes > 0 AND estimated_minutes <= 525600),
  ADD COLUMN archived_at timestamptz;

CREATE INDEX tasks_active_by_user ON tasks(user_id, planned_date)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
