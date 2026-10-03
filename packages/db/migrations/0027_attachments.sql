ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN (
  'inbox','note','task','folder','project','reminder','collection','learning_resource',
  'person','account','category','transaction','debt','attachment'
));
CREATE TABLE attachments (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, parent_id uuid NOT NULL,
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
  declared_mime text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','rejected')),
  storage_key text NOT NULL UNIQUE, upload_id text, session_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, version bigint NOT NULL,
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id,user_id) REFERENCES notes(id,user_id),
  UNIQUE(id,user_id)
);
CREATE INDEX attachments_user_parent ON attachments(user_id,parent_id);
CREATE INDEX attachments_user_created ON attachments(user_id,created_at);
CREATE INDEX attachments_user_version ON attachments(user_id,version);
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON attachments TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO personalspace_app;
