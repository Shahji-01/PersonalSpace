-- Recover requests stranded by the former best-effort API -> Redis handoff.
-- New requests insert the same event atomically with their export_jobs row.
INSERT INTO outbox_events (id, user_id, type, payload, created_at)
SELECT id, user_id, 'exports.generate',
       jsonb_build_object('jobId', id, 'format', format, 'scope', scope), created_at
FROM export_jobs
WHERE status = 'queued'
ON CONFLICT (id) DO NOTHING;

CREATE INDEX export_cleanup_pending ON export_jobs (completed_at, id)
WHERE status = 'expired' AND storage_key IS NOT NULL;
