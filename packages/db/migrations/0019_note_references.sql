ALTER TABLE entity_links DROP CONSTRAINT entity_links_relation_check;
ALTER TABLE entity_links ADD CONSTRAINT entity_links_relation_check
  CHECK (relation IN ('converted_from','related','references'));
CREATE INDEX entity_links_reference_target ON entity_links(user_id,target_id)
  WHERE relation = 'references';
