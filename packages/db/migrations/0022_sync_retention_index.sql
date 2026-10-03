-- UUID/owner reservations remain for idempotency and reference integrity. Old
-- deletion markers leave incremental sync after 180 days and remain available
-- to an explicit full recovery, so stale devices can erase private local copies.
CREATE INDEX entities_expired_purges ON entities(user_id, purged_at, version)
  WHERE purged_at IS NOT NULL;
