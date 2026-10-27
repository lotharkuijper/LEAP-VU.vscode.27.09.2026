-- Terugdraaien van 20261027120000_persona_knowledge.sql.
-- De oude rubric-rijen (project_persona_documents) zijn nooit verwijderd en
-- worden weer gelezen door de vorige versie van de app. Gemigreerde kopieën als
-- projectdocument gaan weg; chunks van projectdocumenten blijven onschadelijk
-- staan (ze vallen buiten de RAG-mappen van de cursus).

DELETE FROM project_documents WHERE migrated_from_persona_doc_id IS NOT NULL;
UPDATE project_documents SET material_kind = 'other' WHERE material_kind = 'rubric';
ALTER TABLE project_documents DROP CONSTRAINT IF EXISTS project_documents_material_kind_check;
ALTER TABLE project_documents ADD CONSTRAINT project_documents_material_kind_check
  CHECK (material_kind IS NULL OR material_kind IN ('assignment','data','literature','other'));
ALTER TABLE project_documents DROP COLUMN IF EXISTS migrated_from_persona_doc_id;

ALTER TABLE project_personas
  DROP COLUMN IF EXISTS course_knowledge,
  DROP COLUMN IF EXISTS course_knowledge_doc_ids,
  DROP COLUMN IF EXISTS project_knowledge_doc_ids;
ALTER TABLE course_personas
  DROP COLUMN IF EXISTS course_knowledge,
  DROP COLUMN IF EXISTS course_knowledge_doc_ids;

DELETE FROM leap_migrations WHERE name = '20261027120000_persona_knowledge.sql';
