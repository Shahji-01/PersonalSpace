CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE search_documents (
  entity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('note','task','project','inbox')),
  title text NOT NULL, body text NOT NULL, extra text NOT NULL,
  title_normalized text NOT NULL, document tsvector NOT NULL,
  status text NOT NULL, archived boolean NOT NULL DEFAULT false,
  project_id uuid, folder_id uuid,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  FOREIGN KEY(entity_id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX search_documents_user ON search_documents(user_id,type);
CREATE INDEX search_documents_terms ON search_documents USING gin(document);
CREATE INDEX search_documents_title ON search_documents USING gin(title_normalized gin_trgm_ops);
ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON search_documents TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON search_documents TO personalspace_app;

WITH source AS (
  SELECT id, user_id, 'note' AS type, title, content_text AS body, 'active' AS status,
    archived_at IS NOT NULL AS archived, NULL::uuid AS project_id, folder_id, created_at, updated_at
    FROM notes WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, user_id, 'task', title, description_text, status, archived_at IS NOT NULL,
    project_id, NULL::uuid, created_at, updated_at FROM tasks WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, user_id, 'project', name, '', status, status = 'archived', NULL::uuid, NULL::uuid,
    created_at, updated_at FROM projects WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, user_id, 'inbox', left(raw_text,120), raw_text, status, false, NULL::uuid, NULL::uuid,
    created_at, updated_at FROM inbox_items WHERE deleted_at IS NULL AND status = 'new'
)
INSERT INTO search_documents
SELECT s.id, s.user_id, s.type, s.title, s.body, array_to_string(e.tags,' '),
  lower(unaccent(s.title)),
  setweight(to_tsvector('simple',unaccent(s.title)),'A') ||
  setweight(to_tsvector('simple',unaccent(s.body)),'B') ||
  setweight(to_tsvector('simple',unaccent(array_to_string(e.tags,' '))),'C'),
  s.status, s.archived, s.project_id, s.folder_id, s.created_at, s.updated_at
FROM source s JOIN entities e ON e.id = s.id AND e.user_id = s.user_id WHERE e.purged_at IS NULL;
