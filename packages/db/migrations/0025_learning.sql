-- Add 'collection' and 'learning_resource' entity types.
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN ('inbox','note','task','folder','project','reminder','collection','learning_resource'));

-- Learning collections: tree structure (max depth 3), same ownership pattern as note folders.
CREATE TABLE learning_collections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  parent_id uuid, sort_order int NOT NULL DEFAULT 0,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id,user_id) REFERENCES learning_collections(id,user_id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX learning_collections_user_parent ON learning_collections(user_id, parent_id);
ALTER TABLE learning_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON learning_collections TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON learning_collections TO personalspace_app;

-- Learning resources: URL-saved items with metadata, progress tracking and optional collection.
CREATE TABLE learning_resources (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  collection_id uuid,
  url text CHECK(url IS NULL OR length(url) <= 2048),
  canonical_url text,
  url_hash text,
  resource_type text NOT NULL CHECK(resource_type IN (
    'youtube_video','youtube_playlist','article','website','documentation',
    'course','pdf','book','podcast','other'
  )),
  source text NOT NULL DEFAULT 'manual' CHECK(source IN ('youtube','web','pdf','book','share','manual')),
  external_id text,
  parent_resource_id uuid,
  position_in_parent int,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  author text CHECK(author IS NULL OR length(author) <= 300),
  description text CHECK(description IS NULL OR length(description) <= 10000),
  thumbnail_url text CHECK(thumbnail_url IS NULL OR length(thumbnail_url) <= 2048),
  duration_seconds int CHECK(duration_seconds IS NULL OR duration_seconds >= 0),
  status text NOT NULL DEFAULT 'saved' CHECK(status IN (
    'saved','want_to_learn','in_progress','completed','paused','archived'
  )),
  progress_percent smallint NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 100),
  progress_seconds int CHECK(progress_seconds IS NULL OR progress_seconds >= 0),
  progress_mode text NOT NULL DEFAULT 'manual' CHECK(progress_mode IN ('auto','manual')),
  metadata_status text NOT NULL DEFAULT 'pending' CHECK(metadata_status IN ('pending','ok','failed')),
  metadata_fetched_at timestamptz,
  last_opened_at timestamptz,
  completed_at timestamptz,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,user_id),
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(collection_id,user_id) REFERENCES learning_collections(id,user_id),
  FOREIGN KEY(parent_resource_id,user_id) REFERENCES learning_resources(id,user_id)
);
CREATE UNIQUE INDEX learning_resources_url_dedup
  ON learning_resources(user_id, url_hash)
  WHERE deleted_at IS NULL AND parent_resource_id IS NULL AND url_hash IS NOT NULL;
CREATE INDEX learning_resources_user_version ON learning_resources(user_id, version);
CREATE INDEX learning_resources_user_collection ON learning_resources(user_id, collection_id)
  WHERE collection_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX learning_resources_user_status ON learning_resources(user_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX learning_resources_parent ON learning_resources(user_id, parent_resource_id)
  WHERE parent_resource_id IS NOT NULL;

ALTER TABLE learning_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON learning_resources TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON learning_resources TO personalspace_app;
