-- Approved, narrowly scoped exception to the ordinary notification erasure
-- inventory. Absolute retention is measured from first capture, not completion.
ALTER TABLE deletion_requests
  ADD COLUMN completion_email_captured_at timestamptz,
  ADD COLUMN completion_email_status text CHECK (completion_email_status IN
    ('pending', 'accepted', 'preview', 'failed', 'expired', 'unavailable'));

CREATE TABLE deletion_completion_outbox (
  id uuid PRIMARY KEY REFERENCES deletion_requests(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  sender text,
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retrying')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 8),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  lease_expires_at timestamptz,
  error_code text CHECK (error_code IN ('provider_rate_limited', 'provider_unavailable', 'network_error')),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK ((claim_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'processing') = (claim_id IS NOT NULL)),
  CHECK (claim_id IS NULL OR (attempts > 0 AND first_attempt_at IS NOT NULL))
);
CREATE INDEX deletion_completion_due ON deletion_completion_outbox(next_attempt_at);
CREATE INDEX deletion_completion_expiry ON deletion_completion_outbox(expires_at);
ALTER TABLE deletion_completion_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON deletion_completion_outbox FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON deletion_completion_outbox TO personalspace_maintenance;
CREATE POLICY maintenance ON deletion_completion_outbox TO personalspace_maintenance USING (true) WITH CHECK (true);

CREATE FUNCTION public.guard_deletion_completion_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.deletion_requests d JOIN public.auth_user u ON u.id = d.user_id
      WHERE d.id = NEW.id AND d.status = 'processing'
        AND d.completion_email_captured_at = NEW.created_at
        AND d.completion_email_status = 'pending'
        AND u.email = NEW.recipient AND u.email NOT LIKE '%@deleted.invalid'
    ) THEN RAISE EXCEPTION 'Completion recipient cannot be captured' USING ERRCODE = '55000'; END IF;
  ELSE
    IF ROW(NEW.id, NEW.recipient, NEW.template_version, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.recipient, OLD.template_version, OLD.created_at, OLD.expires_at)
       OR (OLD.first_attempt_at IS NOT NULL AND
          ROW(NEW.sender, NEW.first_attempt_at) IS DISTINCT FROM ROW(OLD.sender, OLD.first_attempt_at)) THEN
      RAISE EXCEPTION 'Completion envelope is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_deletion_completion_outbox() FROM PUBLIC;
CREATE TRIGGER guard_deletion_completion_outbox BEFORE INSERT OR UPDATE ON deletion_completion_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_deletion_completion_outbox();

-- Prevent a retry from clearing the capture marker and acquiring a new lifetime.
CREATE FUNCTION public.guard_completion_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.completion_email_captured_at IS NOT NULL AND
     NEW.completion_email_captured_at IS DISTINCT FROM OLD.completion_email_captured_at THEN
    RAISE EXCEPTION 'Completion capture timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_completion_capture() FROM PUBLIC;
CREATE TRIGGER guard_completion_capture BEFORE UPDATE ON deletion_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_completion_capture();
