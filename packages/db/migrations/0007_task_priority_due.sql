-- Task priority (0=none .. 4=urgent) and a deadline separate from the planned "do date" (§13.1).
ALTER TABLE tasks ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4);
ALTER TABLE tasks ADD COLUMN due_date date;
CREATE INDEX tasks_user_status_due ON tasks (user_id, status, due_date);
