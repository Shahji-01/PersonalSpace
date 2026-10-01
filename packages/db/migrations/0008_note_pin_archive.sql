-- Note organization (§12.1): pin and favorite flags plus archiving, which is orthogonal to
-- Trash — an archived note is hidden from the active list but not deleted.
ALTER TABLE notes ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE notes ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;
ALTER TABLE notes ADD COLUMN archived_at timestamptz;
