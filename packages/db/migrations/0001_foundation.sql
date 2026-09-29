CREATE TABLE auth_user (
  id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  age_confirmed boolean NOT NULL CHECK (age_confirmed), terms_accepted boolean NOT NULL CHECK (terms_accepted),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_session (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE,
  token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, ip_address text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_user ON auth_session(user_id);
CREATE TABLE auth_account (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE,
  account_id text NOT NULL, provider_id text NOT NULL, password text,
  access_token text, refresh_token text, id_token text, scope text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id, account_id)
);
CREATE INDEX auth_account_user ON auth_account(user_id);
CREATE TABLE auth_verification (
  id uuid PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_sync_state (user_id uuid PRIMARY KEY REFERENCES auth_user ON DELETE CASCADE, version bigint NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991));
CREATE TABLE entities (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE,
  type text NOT NULL CHECK(type IN ('inbox','note','task')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  version bigint NOT NULL, UNIQUE(id, user_id)
);
CREATE INDEX entities_user_version ON entities(user_id, version);
CREATE TABLE inbox_items (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, raw_text text NOT NULL CHECK(length(raw_text) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','converted')), converted_entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version bigint NOT NULL,
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(converted_entity_id,user_id) REFERENCES entities(id,user_id)
);
CREATE INDEX inbox_user_version ON inbox_items(user_id, version);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','done')), planned_date date, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version bigint NOT NULL,
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX tasks_user_version ON tasks(user_id, version);
CREATE INDEX tasks_user_planned ON tasks(user_id, status, planned_date);
CREATE TABLE notes (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL, content_json jsonb NOT NULL, content_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version bigint NOT NULL,
  FOREIGN KEY(id,user_id) REFERENCES entities(id,user_id) ON DELETE CASCADE
);
CREATE INDEX notes_user_version ON notes(user_id, version);
CREATE TABLE entity_links (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE, source_id uuid NOT NULL, target_id uuid NOT NULL,
  relation text NOT NULL CHECK(relation IN ('converted_from')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version bigint NOT NULL,
  FOREIGN KEY(source_id,user_id) REFERENCES entities(id,user_id), FOREIGN KEY(target_id,user_id) REFERENCES entities(id,user_id),
  UNIQUE(source_id,target_id,relation)
);
CREATE INDEX entity_links_user_version ON entity_links(user_id,version);
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE, key uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE, type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(created_at) WHERE processed_at IS NULL;
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_user ON DELETE CASCADE, action text NOT NULL, entity_id uuid NOT NULL, request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Missing app.user_id fails closed. SET LOCAL resets automatically when the pooled transaction ends.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['user_sync_state','entities','inbox_items','tasks','notes','entity_links','idempotency_keys','outbox_events','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY owner ON %I TO personalspace_app USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO personalspace_app, personalspace_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user, auth_session, auth_account, auth_verification TO personalspace_auth;
GRANT SELECT, INSERT, UPDATE ON user_sync_state, entities, inbox_items, tasks, notes, entity_links, idempotency_keys, outbox_events TO personalspace_app;
GRANT SELECT, INSERT ON audit_logs TO personalspace_app;
