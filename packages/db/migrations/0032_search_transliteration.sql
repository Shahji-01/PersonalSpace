-- Cross-script search: alongside the literal `document` vector, store a
-- transliterated `translit` vector so a Hinglish query ("ghar") matches a
-- Devanagari record ("घर") and vice versa. Transliteration is computed in
-- application code (packages/validation/transliterate), so this column is
-- populated by indexSearchRecords rather than a SQL backfill; existing rows
-- gain it the next time their content command re-indexes them.
ALTER TABLE search_documents ADD COLUMN translit tsvector;
CREATE INDEX search_documents_translit ON search_documents USING gin(translit);
