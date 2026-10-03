ALTER TABLE notes
  ADD COLUMN kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'checklist', 'daily', 'voice')),
  ADD COLUMN daily_date date,
  ADD CONSTRAINT notes_daily_date_kind CHECK ((kind = 'daily') = (daily_date IS NOT NULL));

CREATE UNIQUE INDEX notes_one_daily_per_date ON notes(user_id, daily_date)
  WHERE kind = 'daily' AND deleted_at IS NULL;
