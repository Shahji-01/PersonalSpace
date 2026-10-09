-- Account deletion must erase cached command responses, Inbox provenance,
-- recurrence definitions and sync state as well as the visible domain rows.
ALTER TABLE deletion_requests ADD COLUMN storage_cleanup_after timestamptz;
ALTER TABLE deletion_requests ADD COLUMN storage_cleanup_keys jsonb NOT NULL DEFAULT '[]';
-- Older workers could report completion without cleaning storage or retry data.
UPDATE deletion_requests SET status = 'processing', step = 'recovery',
  started_at = now() - interval '16 minutes', completed_at = NULL
WHERE status = 'completed';

-- Serialize the deletion claim against writes already in flight. The guard is
-- also applied to background/auth roles; RLS alone cannot fence those writers.
CREATE FUNCTION public.reject_erasing_account_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deletion_status text; deletion_started timestamptz; account_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'auth_user' THEN
    account_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'auth_verification' THEN
    -- Better Auth's password-reset record stores the user UUID as its value.
    IF NEW.identifier NOT LIKE 'reset-password:%' OR
       NEW.value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN NEW;
    END IF;
    account_id := NEW.value::uuid;
  ELSE
    account_id := NEW.user_id;
  END IF;
  SELECT status, started_at INTO deletion_status, deletion_started
    FROM public.deletion_requests WHERE user_id = account_id FOR SHARE;
  IF deletion_status IN ('processing', 'completed') OR
     (deletion_status = 'pending' AND deletion_started IS NOT NULL) THEN
    -- The only permitted auth-user update is the erasure tombstone itself.
    IF TG_TABLE_NAME = 'auth_user' THEN
      IF NEW.name = 'Deleted User' AND NEW.email = 'deleted+' || NEW.id::text || '@deleted.invalid'
         AND NEW.image IS NULL AND NOT NEW.email_verified THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Account deletion is in progress' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reject_erasing_account_write() FROM PUBLIC;

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'auth_user', 'auth_session', 'auth_account', 'auth_verification', 'user_sync_state', 'entities',
    'inbox_items', 'notes', 'tasks', 'note_folders', 'projects', 'recurrence_rules',
    'note_versions', 'entity_links', 'attachments', 'search_documents',
    'reminders', 'learning_collections', 'learning_resources', 'people',
    'finance_accounts', 'finance_categories', 'debts', 'finance_transactions',
    'transaction_splits', 'transaction_revisions', 'idempotency_keys',
    'outbox_events', 'audit_logs', 'user_preferences', 'device_tokens',
    'notification_log', 'export_jobs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER reject_erasing_account_write BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_erasing_account_write()', relation);
  END LOOP;
END $$;

-- Erase reset tokens without granting the background role permission to read
-- verification values for every account.
CREATE FUNCTION public.erase_account_reset_tokens(account_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.deletion_requests WHERE user_id = account_id
                 AND status = 'processing') THEN
    RAISE EXCEPTION 'Account deletion has not started';
  END IF;
  DELETE FROM public.auth_verification WHERE value = account_id::text
    AND identifier LIKE 'reset-password:%';
END $$;
REVOKE ALL ON FUNCTION public.erase_account_reset_tokens(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RETURN;
  END IF;
  GRANT SELECT, DELETE ON inbox_items, recurrence_rules, user_sync_state TO personalspace_maintenance;
  GRANT EXECUTE ON FUNCTION public.erase_account_reset_tokens(uuid) TO personalspace_maintenance;
  CREATE POLICY maintenance ON inbox_items TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON recurrence_rules TO personalspace_maintenance USING (true) WITH CHECK (true);
  CREATE POLICY maintenance ON user_sync_state TO personalspace_maintenance USING (true) WITH CHECK (true);
END $$;
