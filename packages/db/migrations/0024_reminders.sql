-- Add the 'reminder' entity type to the entities type constraint.
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN ('inbox','note','task','folder','project','reminder'));

CREATE TABLE reminders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  entity_id uuid,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  remind_date date NOT NULL,
  remind_time time NOT NULL,
  time_mode text NOT NULL DEFAULT 'floating' CHECK(time_mode IN ('floating','fixed')),
  timezone text NOT NULL,
  fire_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','fired','snoozed','dismissed','done','cancelled')),
  snoozed_until timestamptz,
  last_fired_at timestamptz,
  recurrence_rule_id uuid,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(entity_id,user_id) REFERENCES entities(id,user_id),
  FOREIGN KEY(recurrence_rule_id,user_id) REFERENCES recurrence_rules(id,user_id)
);
CREATE INDEX reminders_user_version ON reminders(user_id, version);
CREATE INDEX reminders_fire_at ON reminders(fire_at)
  WHERE status IN ('scheduled','snoozed') AND deleted_at IS NULL;
CREATE INDEX reminders_user_entity ON reminders(user_id, entity_id)
  WHERE entity_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON reminders TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON reminders TO personalspace_app;
