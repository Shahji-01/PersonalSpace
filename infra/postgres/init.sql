-- Local development credentials only. Production roles come from secret-managed provisioning.
CREATE ROLE personalspace_app LOGIN PASSWORD 'local_app_only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE personalspace_auth LOGIN PASSWORD 'local_auth_only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE personalspace_worker LOGIN PASSWORD 'local_worker_only' NOSUPERUSER NOBYPASSRLS;
-- Nightly maintenance runs cross-user system cleanup (Trash purge, tombstone and
-- idempotency expiry, balance reconciliation, export expiry). It is kept separate
-- from the sync relay so the relay still sees only outbox metadata.
CREATE ROLE personalspace_maintenance LOGIN PASSWORD 'local_maintenance_only' NOSUPERUSER NOBYPASSRLS;
