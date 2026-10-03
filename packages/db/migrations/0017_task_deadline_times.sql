ALTER TABLE tasks
  ADD COLUMN due_time time,
  ADD COLUMN time_mode text NOT NULL DEFAULT 'floating' CHECK (time_mode IN ('floating','fixed')),
  ADD COLUMN timezone text,
  ADD COLUMN due_at timestamptz,
  ADD CONSTRAINT tasks_timed_deadline CHECK (
    (due_time IS NULL AND time_mode = 'floating' AND timezone IS NULL AND due_at IS NULL)
    OR (due_time IS NOT NULL AND due_date IS NOT NULL AND timezone IS NOT NULL
        AND ((time_mode = 'fixed' AND due_at IS NOT NULL) OR (time_mode = 'floating' AND due_at IS NULL)))
  );
CREATE INDEX tasks_fixed_deadlines ON tasks(user_id,due_at)
  WHERE due_at IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL;
