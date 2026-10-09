-- Keep background privileges limited to the purge's sync/audit bookkeeping.
-- Existing SELECT/DELETE grants cover content erasure. No auth grants are added.
CREATE INDEX entities_trash_retention ON entities(deleted_at, id)
  WHERE purged_at IS NULL AND deleted_at IS NOT NULL;
CREATE INDEX idempotency_response_retention ON idempotency_keys(created_at, user_id, key)
  WHERE response <> '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RETURN;
  END IF;
  GRANT UPDATE(version) ON user_sync_state TO personalspace_maintenance;
  GRANT UPDATE(version, updated_at, deleted_at, purged_at, tags) ON entities TO personalspace_maintenance;
  GRANT UPDATE(response) ON idempotency_keys TO personalspace_maintenance;
  GRANT UPDATE(converted_entity_id, version, updated_at) ON inbox_items TO personalspace_maintenance;
  GRANT UPDATE(version, updated_at) ON projects TO personalspace_maintenance;
  GRANT INSERT ON outbox_events, audit_logs TO personalspace_maintenance;
  -- Reconciliation is diagnostic. It must not overwrite concurrent ledger writes.
  REVOKE UPDATE ON finance_accounts FROM personalspace_maintenance;
END $$;
