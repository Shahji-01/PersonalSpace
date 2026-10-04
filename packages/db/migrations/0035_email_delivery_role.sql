-- Transactional email delivery (processPendingEmails) is a cross-user background
-- job and runs under the privileged background role. Beyond what 0034 granted on
-- notification_log (SELECT, INSERT), it needs UPDATE (to mark rows sent/failed)
-- and the recipient's address. auth_user has no RLS and keeps credentials in
-- auth_account, so a column-level SELECT (id, email) exposes only what the job
-- needs — never the password hash or other profile fields.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping email-delivery grants';
    RETURN;
  END IF;

  GRANT UPDATE ON notification_log TO personalspace_maintenance;
  GRANT SELECT (id, email) ON auth_user TO personalspace_maintenance;
END $$;
