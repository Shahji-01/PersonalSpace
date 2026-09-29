-- Permanent purge of a trashed note removes its entity row (cascading to the note) after the
-- provenance link is cleared. The application role can already delete its own rows under RLS;
-- it only lacks the table-level DELETE privilege on these two tables.
GRANT DELETE ON entities, entity_links TO personalspace_app;
