-- Local development credentials only. Production roles come from secret-managed provisioning.
CREATE ROLE personalspace_app LOGIN PASSWORD 'local_app_only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE personalspace_auth LOGIN PASSWORD 'local_auth_only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE personalspace_worker LOGIN PASSWORD 'local_worker_only' NOSUPERUSER NOBYPASSRLS;
