-- The relay can see only metadata outbox rows, never notes, tasks or auth credentials.
GRANT USAGE ON SCHEMA public TO personalspace_worker;
GRANT SELECT, UPDATE ON outbox_events TO personalspace_worker;
CREATE POLICY outbox_relay ON outbox_events TO personalspace_worker USING (true) WITH CHECK (true);
