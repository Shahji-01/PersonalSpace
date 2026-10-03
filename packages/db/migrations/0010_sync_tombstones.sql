-- Keep only an ownership/version marker after permanent purge. This reserves the UUID
-- and lets offline devices observe deletion on the same ordered stream as normal writes.
ALTER TABLE entities ADD COLUMN purged_at timestamptz;
UPDATE entities e SET deleted_at = item.deleted_at FROM (
  SELECT id, deleted_at FROM notes UNION ALL
  SELECT id, deleted_at FROM tasks UNION ALL
  SELECT id, deleted_at FROM inbox_items
) item WHERE item.id = e.id AND item.deleted_at IS NOT NULL;
GRANT DELETE ON notes, tasks, inbox_items TO personalspace_app;

-- Earlier releases deleted the marker too. Reconstruct it from metadata-only purge
-- audits, assigning a new version so devices whose cursors advanced see the deletion.
WITH bumped AS (
  UPDATE user_sync_state s SET version = s.version + 1
  WHERE EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.user_id = s.user_id AND a.action IN ('note.purge','task.purge','inbox.purge')
      AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = a.entity_id)
  ) RETURNING user_id, version
), purges AS (
  SELECT DISTINCT ON (a.entity_id) a.* FROM audit_logs a
  WHERE a.action IN ('note.purge','task.purge','inbox.purge')
  ORDER BY a.entity_id, a.created_at DESC
)
INSERT INTO entities(id,user_id,type,created_at,updated_at,deleted_at,purged_at,version,tags)
SELECT a.entity_id,a.user_id,split_part(a.action,'.',1),a.created_at,a.created_at,
  a.created_at,a.created_at,b.version,'{}'::text[]
FROM purges a JOIN bumped b ON b.user_id = a.user_id
ON CONFLICT (id) DO NOTHING;

-- A permanent purge must also erase content copies in retry responses, while keeping
-- the request hash/key so an old offline retry cannot recreate the deleted item.
UPDATE idempotency_keys k SET response = (
  SELECT coalesce(jsonb_agg(entry ORDER BY ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(k.response) WITH ORDINALITY AS r(entry,ordinal)
  WHERE NOT EXISTS (
    SELECT 1 FROM entities e
    WHERE e.user_id = k.user_id AND e.id::text = entry->>'id' AND e.purged_at IS NOT NULL
  )
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(k.response) entry JOIN entities e
    ON e.id::text = entry->>'id' AND e.user_id = k.user_id AND e.purged_at IS NOT NULL
);
