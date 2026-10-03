ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN ('inbox','note','task','folder','project'));
CREATE TABLE projects (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  color text NOT NULL CHECK(color ~ '^#[0-9a-fA-F]{6}$'),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  sort_order integer NOT NULL DEFAULT 0, version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(id,user_id), FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX projects_user_order ON projects(user_id,status,sort_order);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON projects TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE ON projects TO personalspace_app;
ALTER TABLE tasks ADD COLUMN project_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_project_owner_fk FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id);
CREATE INDEX tasks_user_project ON tasks(user_id,project_id);
