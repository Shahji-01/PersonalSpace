-- Tags live on the shared entity row so a single command can label any item type. The GIN
-- index supports future server-side tag search; current filtering happens on the client.
ALTER TABLE entities ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX entities_tags ON entities USING gin (tags);
