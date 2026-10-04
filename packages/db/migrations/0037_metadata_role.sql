-- Learning metadata fetching (processPendingMetadata) runs as a cross-user
-- background job under the privileged background role. Beyond the SELECT granted
-- in 0033 it UPDATEs learning_resources with fetched title/description/thumbnail,
-- and when a YouTube playlist is expanded it INSERTs child resources (and their
-- entity rows). Grant those; permissive policies from 0033 already cover
-- learning_resources and entities.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'personalspace_maintenance') THEN
    RAISE NOTICE 'personalspace_maintenance role absent; skipping metadata grants';
    RETURN;
  END IF;

  GRANT INSERT, UPDATE ON learning_resources TO personalspace_maintenance;
  GRANT INSERT ON entities TO personalspace_maintenance;
END $$;
