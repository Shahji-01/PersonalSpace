ALTER TABLE notes ADD CONSTRAINT notes_id_user_unique UNIQUE(id,user_id);
CREATE TABLE note_versions (
  id uuid PRIMARY KEY, note_id uuid NOT NULL, user_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version > 0), title text NOT NULL,
  content_json jsonb NOT NULL, content_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK(reason IN ('session_end','interval','restore')),
  FOREIGN KEY(note_id,user_id) REFERENCES notes(id,user_id) ON DELETE CASCADE,
  UNIQUE(note_id,version)
);
CREATE INDEX note_versions_user_note_version ON note_versions(user_id,note_id,version DESC);
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON note_versions TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, DELETE ON note_versions TO personalspace_app;

-- Preserve the current content before the first post-upgrade edit. Reusing the note's
-- UUID for this initial snapshot is collision-free within the new table.
INSERT INTO note_versions(id,note_id,user_id,version,title,content_json,content_schema_version,created_at,reason)
SELECT id,id,user_id,version,title,content_json,content_schema_version,updated_at,'session_end' FROM notes;
