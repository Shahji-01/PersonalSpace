-- Additive email delivery state. Existing pending/sent/failed rows are preserved;
-- migration alone must never resend historical messages or invent provider receipts.
ALTER TABLE notification_log
  ADD COLUMN email_to text,
  ADD COLUMN email_from text,
  ADD COLUMN email_html text,
  ADD COLUMN email_expires_at timestamptz,
  ADD COLUMN email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN email_first_attempt_at timestamptz,
  ADD COLUMN email_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN email_claim_id uuid,
  ADD COLUMN email_lease_expires_at timestamptz,
  ADD COLUMN email_provider_id text,
  ADD COLUMN email_accepted_at timestamptz,
  ADD COLUMN email_error_code text;

ALTER TABLE notification_log
  ADD CONSTRAINT email_attempts_nonnegative CHECK (email_attempts >= 0),
  ADD CONSTRAINT email_claim_pair CHECK
    ((email_claim_id IS NULL) = (email_lease_expires_at IS NULL)),
  ADD CONSTRAINT email_claim_channel CHECK
    (email_claim_id IS NULL OR (channel = 'email' AND status = 'processing' AND email_attempts > 0 AND email_first_attempt_at IS NOT NULL)),
  ADD CONSTRAINT email_processing_claim CHECK
    (channel <> 'email' OR status <> 'processing' OR email_claim_id IS NOT NULL),
  ADD CONSTRAINT email_error_code_known CHECK
    (email_error_code IS NULL OR email_error_code IN (
      'configuration_missing', 'recipient_missing', 'recipient_changed', 'expired',
      'provider_rate_limited', 'provider_unavailable', 'provider_rejected',
      'network_error', 'attempts_exhausted', 'delivery_uncertain', 'legacy_delivery_failure'
    ));

CREATE INDEX email_delivery_due ON notification_log(email_next_attempt_at, created_at, id)
  WHERE channel = 'email' AND status IN ('pending', 'retrying');
CREATE INDEX email_delivery_leases ON notification_log(email_lease_expires_at, id)
  WHERE channel = 'email' AND status = 'processing';

-- The row UUID is the stable provider idempotency identity. Freeze its envelope
-- after the first attempt so a crash/retry cannot reuse that key for other content.
CREATE FUNCTION public.preserve_email_delivery_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.channel = 'email' AND OLD.email_first_attempt_at IS NOT NULL AND
     ROW(NEW.id, NEW.user_id, NEW.channel, NEW.dedupe_key, NEW.title, NEW.body,
         NEW.email_to, NEW.email_from, NEW.email_html, NEW.email_first_attempt_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.user_id, OLD.channel, OLD.dedupe_key, OLD.title, OLD.body,
         OLD.email_to, OLD.email_from, OLD.email_html, OLD.email_first_attempt_at) THEN
    RAISE EXCEPTION 'Email delivery envelope is immutable after an attempt' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.preserve_email_delivery_envelope() FROM PUBLIC;
CREATE TRIGGER preserve_email_delivery_envelope BEFORE UPDATE ON notification_log
  FOR EACH ROW EXECUTE FUNCTION public.preserve_email_delivery_envelope();

-- Reuse the existing owner policy and dedicated maintenance delivery grants.
-- The sync relay and auth roles get no notification or credential privileges.
-- The existing account-erasure fence and notification deletion inventory also
-- cover these fields; no separate personal-data table is introduced.
REVOKE ALL ON notification_log FROM PUBLIC;
ALTER POLICY notification_log_owner ON notification_log TO personalspace_app
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
