ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN ('inbox','note','task','folder'));
CREATE TABLE note_folders (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  parent_id uuid, version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id,user_id) REFERENCES note_folders(id,user_id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX note_folders_user_parent ON note_folders(user_id,parent_id);
ALTER TABLE note_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON note_folders TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON note_folders TO personalspace_app;
ALTER TABLE notes ADD COLUMN folder_id uuid;
ALTER TABLE notes ADD CONSTRAINT notes_folder_owner_fk FOREIGN KEY(folder_id,user_id) REFERENCES note_folders(id,user_id);
CREATE INDEX notes_user_folder ON notes(user_id,folder_id);
