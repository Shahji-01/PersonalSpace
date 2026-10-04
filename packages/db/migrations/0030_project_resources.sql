ALTER TABLE entity_links DROP CONSTRAINT entity_links_relation_check;
ALTER TABLE entity_links ADD CONSTRAINT entity_links_relation_check
  CHECK (relation IN ('converted_from','related','references','related_resource'));
CREATE INDEX entity_links_related_resource_target ON entity_links(user_id,target_id)
  WHERE relation = 'related_resource';
