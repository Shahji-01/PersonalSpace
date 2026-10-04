-- Account deletion (executePendingDeletions) runs as a cross-user background job
-- under the privileged background role. It hard-deletes a user's rows across every
-- domain and infrastructure table and marks the deletion_requests row completed
-- (kept as a ledger). It does NOT touch the auth tables — auth_user/auth_account
-- remain — so no sensitive auth grant is needed here.
--
-- Grant DELETE (with SELECT, since DELETE ... WHERE user_id reads the column) on
-- the tables not already covered by migrations 0033–0037, plus SELECT/UPDATE on
-- deletion_requests, with permissive policies for the tables lacking one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping deletion grants';
    RETURN;
  END IF;

  -- Already SELECTable from earlier migrations; add DELETE.
  GRANT DELETE ON note_folders, projects, transaction_splits, device_tokens,
    notification_log, export_jobs TO personalspace_maintenance;

  -- Not previously granted; deletion needs SELECT + DELETE.
  GRANT SELECT, DELETE ON transaction_revisions, note_versions, attachments,
    search_documents, user_preferences, outbox_events, audit_logs, entity_links
    TO personalspace_maintenance;

  -- The deletion ledger row is read and updated through the pipeline.
  GRANT SELECT, UPDATE ON deletion_requests TO personalspace_maintenance;

  -- Permissive policies for tables without an existing maintenance policy.
  CREATE POLICY maintenance ON transaction_revisions TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON note_versions TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON attachments TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON search_documents TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON user_preferences TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON outbox_events TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON audit_logs TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON entity_links TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON deletion_requests TO personalspace_maintenance USING (true) WITH CHECK (true);
END $$;
