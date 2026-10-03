-- Account deletion cascades through entities and recurrence_rules separately.
-- Check these ownership links after all cascades have completed, while still
-- rejecting dangling/cross-account links at transaction commit.
ALTER TABLE tasks ALTER CONSTRAINT tasks_recurrence_owner_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE tasks ALTER CONSTRAINT tasks_next_occurrence_owner_fk DEFERRABLE INITIALLY DEFERRED;
