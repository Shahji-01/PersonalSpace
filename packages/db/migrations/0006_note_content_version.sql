-- Legacy note JSON is already the v1 paragraph subset; no content rewrite is required.
ALTER TABLE notes ADD COLUMN content_schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE notes ADD CONSTRAINT note_content_schema_version_positive CHECK (content_schema_version > 0);
