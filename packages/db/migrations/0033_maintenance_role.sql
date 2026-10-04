-- Grant the maintenance role exactly what the nightly jobs touch
-- (packages/domain/maintenance): hard-deleting 30-day Trash, expiring
-- tombstones and idempotency keys, reconciling account balances and expiring
-- exports. These are cross-user system operations, so each table gets a
-- permissive maintenance policy alongside its per-user owner policy, mirroring
-- the outbox_relay precedent in migration 0002. The role itself is provisioned
-- outside migrations (infra/postgres/init.sql locally, secret management in
-- production); the guard keeps `db:migrate` working on databases where it has
-- not been created yet.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping maintenance grants';
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA public TO personalspace_maintenance;

  -- Trash purge reads entities and deletes from every domain table. DELETE with a
  -- WHERE clause also needs SELECT on the referenced columns, so grant both.
  GRANT SELECT, DELETE ON entities TO personalspace_maintenance;
  GRANT SELECT, DELETE ON notes, tasks, reminders, learning_resources, learning_collections,
    debts, finance_categories, people TO personalspace_maintenance;
  GRANT SELECT, DELETE ON finance_transactions TO personalspace_maintenance;
  -- Balance reconciliation reads transactions/accounts and corrects cached balances.
  GRANT SELECT, UPDATE, DELETE ON finance_accounts TO personalspace_maintenance;
  -- Idempotency and export expiry.
  GRANT SELECT, DELETE ON idempotency_keys TO personalspace_maintenance;
  GRANT SELECT, UPDATE ON export_jobs TO personalspace_maintenance;

  CREATE POLICY maintenance ON entities TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON notes TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON tasks TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON reminders TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON learning_resources TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON learning_collections TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON finance_transactions TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON finance_accounts TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON finance_categories TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON debts TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON people TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON idempotency_keys TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON export_jobs TO personalspace_maintenance USING (true) WITH CHECK (true);
END $$;
