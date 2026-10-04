-- The search index was extended to reminders, learning and money records, but the
-- type check constraint from migration 0016 still only allowed the original four
-- content types. Any command that indexed a later-module record (for example
-- resource.save) therefore failed. Widen the constraint to every type that
-- indexSearchRecords writes (everything except folders and attachments).
ALTER TABLE search_documents DROP CONSTRAINT search_documents_type_check;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_type_check
  CHECK (type IN (
    'note','task','project','inbox','reminder','collection','learning_resource',
    'person','account','category','transaction','debt'
  ));
