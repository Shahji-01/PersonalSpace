CREATE TABLE recurrence_rules (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  rrule text NOT NULL, settings jsonb NOT NULL, template jsonb NOT NULL,
  version bigint NOT NULL, ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(id,user_id)
);
ALTER TABLE recurrence_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurrence_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON recurrence_rules TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON recurrence_rules TO personalspace_app;
ALTER TABLE tasks
  ADD COLUMN recurrence_rule_id uuid,
  ADD COLUMN recurrence_series_id uuid,
  ADD COLUMN occurrence_date date,
  ADD COLUMN occurrence_number integer,
  ADD COLUMN next_task_id uuid,
  ADD COLUMN recurrence_advanced boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT tasks_recurrence_owner_fk FOREIGN KEY(recurrence_rule_id,user_id) REFERENCES recurrence_rules(id,user_id),
  ADD CONSTRAINT tasks_next_occurrence_owner_fk FOREIGN KEY(next_task_id,user_id) REFERENCES entities(id,user_id),
  ADD CONSTRAINT tasks_recurrence_shape CHECK (
    (recurrence_rule_id IS NULL AND recurrence_series_id IS NULL AND occurrence_date IS NULL AND occurrence_number IS NULL)
    OR (recurrence_rule_id IS NOT NULL AND recurrence_series_id IS NOT NULL AND occurrence_date IS NOT NULL AND occurrence_number > 0)
  ),
  ADD CONSTRAINT tasks_recurrence_occurrence_unique UNIQUE(recurrence_rule_id,occurrence_number);
CREATE INDEX tasks_user_recurrence ON tasks(user_id,recurrence_rule_id);
