-- Data export (generateExportData) runs as a cross-user background job under the
-- privileged background role. It reads one user's data across all domain tables.
-- Migration 0033 already grants SELECT on most of them and SELECT/UPDATE on
-- export_jobs; export additionally reads note_folders, projects and
-- transaction_splits, so grant SELECT with permissive policies on those three.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping export grants';
    RETURN;
  END IF;

  GRANT SELECT ON note_folders, projects, transaction_splits TO personalspace_maintenance;

  CREATE POLICY maintenance ON note_folders TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON projects TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON transaction_splits TO personalspace_maintenance USING (true) WITH CHECK (true);
END $$;
