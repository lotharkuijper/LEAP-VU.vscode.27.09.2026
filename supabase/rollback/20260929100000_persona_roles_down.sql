-- TERUGDRAAIEN van 20260929100000_persona_roles.sql.
-- Let op: rolspelers worden weer gewone gesprekspersona's, ingeleverd werk bij
-- beoordelaars (en de oordelen daarop) verdwijnt, en verstandhoudingen worden
-- op neutraal gezet (de oude schaal -10..+10 had een andere betekenis).
BEGIN;

DELETE FROM project_document_reviews WHERE document_id IS NULL;
DROP INDEX IF EXISTS idx_pdr_product;
DROP INDEX IF EXISTS idx_pdr_group_persona;
ALTER TABLE project_document_reviews DROP CONSTRAINT IF EXISTS pdr_document_or_product;
ALTER TABLE project_document_reviews DROP COLUMN IF EXISTS product_id;
ALTER TABLE project_document_reviews ALTER COLUMN document_id SET NOT NULL;
DROP TABLE IF EXISTS project_group_products;

UPDATE project_persona_relationships SET score = 0;

UPDATE project_personas SET persona_type = 'conversational' WHERE persona_type = 'roleplayer';
UPDATE course_personas  SET persona_type = 'conversational' WHERE persona_type = 'roleplayer';
ALTER TABLE project_personas DROP CONSTRAINT IF EXISTS project_personas_persona_type_check;
ALTER TABLE course_personas  DROP CONSTRAINT IF EXISTS course_personas_persona_type_check;
ALTER TABLE project_personas ADD CONSTRAINT project_personas_persona_type_check
  CHECK (persona_type IN ('conversational', 'evaluator'));
ALTER TABLE course_personas ADD CONSTRAINT course_personas_persona_type_check
  CHECK (persona_type IN ('conversational', 'evaluator'));

ALTER TABLE project_personas
  DROP COLUMN IF EXISTS reputation_enabled,
  DROP COLUMN IF EXISTS conduct_rules,
  DROP COLUMN IF EXISTS start_level,
  DROP COLUMN IF EXISTS deliverable_label,
  DROP COLUMN IF EXISTS max_reviews;
ALTER TABLE course_personas
  DROP COLUMN IF EXISTS reputation_enabled,
  DROP COLUMN IF EXISTS conduct_rules,
  DROP COLUMN IF EXISTS start_level,
  DROP COLUMN IF EXISTS deliverable_label,
  DROP COLUMN IF EXISTS max_reviews;

COMMIT;
