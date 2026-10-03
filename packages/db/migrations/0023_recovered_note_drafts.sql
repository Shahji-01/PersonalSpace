ALTER TABLE notes ADD COLUMN recovered_from_id uuid;
ALTER TABLE notes ADD CONSTRAINT notes_recovered_source_owner_fk
  FOREIGN KEY (recovered_from_id,user_id) REFERENCES entities(id,user_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX notes_recovered_source ON notes(user_id,recovered_from_id)
  WHERE recovered_from_id IS NOT NULL;
