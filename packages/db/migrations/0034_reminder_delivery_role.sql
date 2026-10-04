-- Reminder delivery (deliverDueReminders) is a cross-user background job and so
-- runs under the same privileged worker role as maintenance. Grant it the extra
-- privileges that job needs beyond migration 0033: UPDATE reminders (to stamp
-- last_fired_at; SELECT was already granted), SELECT device_tokens, and
-- SELECT/INSERT notification_log (idempotent push logging). Permissive policies
-- mirror the per-user owner policies, matching migration 0033.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping reminder-delivery grants';
    RETURN;
  END IF;

  GRANT UPDATE ON reminders TO personalspace_maintenance;
  GRANT SELECT ON device_tokens TO personalspace_maintenance;
  GRANT SELECT, INSERT ON notification_log TO personalspace_maintenance;

  CREATE POLICY maintenance ON device_tokens TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON notification_log TO personalspace_maintenance USING (true) WITH CHECK (true);
END $$;
