ALTER TABLE attachments
  ADD COLUMN processed_key text,
  ADD COLUMN thumbnail_key text,
  ADD COLUMN processed_mime text,
  ADD COLUMN processed_size integer CHECK(processed_size BETWEEN 1 AND 26214400),
  ADD COLUMN thumbnail_size integer NOT NULL DEFAULT 0 CHECK(thumbnail_size BETWEEN 0 AND 26214400),
  ADD COLUMN processed_sha256 text CHECK(processed_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN rejection_reason text CHECK(rejection_reason IN ('integrity','type','malware','invalid_image','missing','quota')),
  ADD COLUMN processing_token uuid,
  ADD COLUMN processing_lease_until timestamptz;
ALTER TABLE attachments ADD CONSTRAINT attachment_ready_output CHECK (
  status <> 'ready' OR (processed_key IS NOT NULL AND processed_mime IS NOT NULL
    AND processed_size IS NOT NULL AND processed_sha256 IS NOT NULL));

-- Provision a separate processor identity; operators set its login/secret outside migrations.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='personalspace_attachment_processor') THEN
    CREATE ROLE personalspace_attachment_processor NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO personalspace_attachment_processor;
GRANT SELECT ON attachments, user_sync_state, entities TO personalspace_attachment_processor;
GRANT UPDATE(status,processed_key,thumbnail_key,processed_mime,processed_size,processed_sha256,thumbnail_size,
  rejection_reason,processing_token,processing_lease_until,version,updated_at)
  ON attachments TO personalspace_attachment_processor;
GRANT INSERT, UPDATE ON user_sync_state TO personalspace_attachment_processor;
GRANT UPDATE(version,updated_at) ON entities TO personalspace_attachment_processor;
GRANT INSERT ON outbox_events, audit_logs TO personalspace_attachment_processor;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['attachments','user_sync_state','outbox_events','audit_logs'] LOOP
    EXECUTE format('CREATE POLICY attachment_processor ON %I TO personalspace_attachment_processor
      USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
      WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
CREATE POLICY attachment_processor ON entities TO personalspace_attachment_processor
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid AND type='attachment')
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid AND type='attachment');
