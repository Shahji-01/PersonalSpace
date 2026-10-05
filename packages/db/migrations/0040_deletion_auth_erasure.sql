-- Account deletion now erases authentication PII: it deletes the user's sessions
-- and credential/provider accounts and anonymizes the auth_user row (keeping the
-- id so the deletion_requests ledger survives). Grant the background role the
-- needed access. Auth tables have no RLS, so grants alone suffice. The UPDATE is
-- column-scoped so the role can never read or change credentials.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping deletion auth grants';
    RETURN;
  END IF;

  -- Column-scoped SELECT (only user_id, for the DELETE WHERE) keeps credentials
  -- such as auth_account.password unreadable by the background role.
  GRANT SELECT (user_id), DELETE ON auth_session TO personalspace_maintenance;
  GRANT SELECT (user_id), DELETE ON auth_account TO personalspace_maintenance;
  GRANT SELECT (id), UPDATE (email, name, image, email_verified, updated_at) ON auth_user
    TO personalspace_maintenance;
END $$;
