-- Wat kent een persona? (2026-10-27)
--
-- Per persona kiest de docent welke kennis die persona gebruikt:
--   course_knowledge           'none' | 'all' | 'selected' (cursusmateriaal)
--   course_knowledge_doc_ids   de gekozen cursusbestanden bij 'selected'
--   project_knowledge_doc_ids  de gekozen projectdocumenten (project_documents.id)
-- Studenten zien deze keuze niet. Databestanden zijn nooit persona-kennis (server).
-- Nieuwe persona's kennen standaard niets: alleen hun prompt.
--
-- Bestaande persona's houden wat ze lazen: rag_enabled → 'all' (anders 'none'),
-- en alle projectdocumenten die zichtbaar waren voor studenten en tekst hebben
-- (geen databestanden). Verborgen rubrics van beoordelaars
-- (project_persona_documents.is_hidden_rubric) worden projectdocumenten van
-- soort 'rubric', gekend door die beoordelaar. De oude rijen blijven staan
-- (terugdraaien), maar worden niet meer gelezen.
--
-- Terugdraaien: supabase/rollback/20261027120000_persona_knowledge_down.sql

ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS course_knowledge text NOT NULL DEFAULT 'none'
    CHECK (course_knowledge IN ('none','all','selected')),
  ADD COLUMN IF NOT EXISTS course_knowledge_doc_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS project_knowledge_doc_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE course_personas
  ADD COLUMN IF NOT EXISTS course_knowledge text NOT NULL DEFAULT 'none'
    CHECK (course_knowledge IN ('none','all','selected')),
  ADD COLUMN IF NOT EXISTS course_knowledge_doc_ids uuid[] NOT NULL DEFAULT '{}';

-- Soort 'rubric' voor beoordelingsmateriaal.
ALTER TABLE project_documents DROP CONSTRAINT IF EXISTS project_documents_material_kind_check;
ALTER TABLE project_documents ADD CONSTRAINT project_documents_material_kind_check
  CHECK (material_kind IS NULL OR material_kind IN ('assignment','data','literature','rubric','other'));

-- Oude rubric-rijen: herkomst bijhouden zodat de migratie ze niet dubbel kopieert.
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS migrated_from_persona_doc_id uuid;

-- 1) Bestaande persona's: cursusmateriaal zoals voorheen.
UPDATE project_personas SET course_knowledge = CASE WHEN rag_enabled THEN 'all' ELSE 'none' END;
UPDATE course_personas SET course_knowledge = CASE WHEN rag_enabled THEN 'all' ELSE 'none' END;

-- 2) Bestaande chat-persona's: alle voor studenten zichtbare tekstdocumenten van hun project.
UPDATE project_personas pp
   SET project_knowledge_doc_ids = COALESCE((
     SELECT array_agg(pd.id ORDER BY pd.created_at)
       FROM project_documents pd
      WHERE pd.project_id = pp.project_id
        AND pd.is_visible_to_students = true
        AND pd.content_text IS NOT NULL
        AND COALESCE(pd.material_kind, '') <> 'data'
        AND pd.filename !~* '\.(xlsx|xls|csv|tsv|ods|sav|omv|omt|jasp|rdata|rds|sps|do|dta)$'
   ), '{}')
 WHERE COALESCE(pp.persona_type, 'conversational') <> 'evaluator';

-- 3) Verborgen rubrics → projectdocumenten van soort 'rubric', gekend door de beoordelaar.
INSERT INTO project_documents (project_id, filename, content_text, byte_size, mime_type,
                               material_kind, is_visible_to_students, uploaded_by, created_at,
                               migrated_from_persona_doc_id)
SELECT d.project_id, d.filename, d.content_text, d.byte_size, 'text/plain',
       'rubric', COALESCE(d.visible_to_students, false), d.uploaded_by, d.created_at, d.id
  FROM project_persona_documents d
 WHERE d.is_hidden_rubric = true
   AND NOT EXISTS (SELECT 1 FROM project_documents x WHERE x.migrated_from_persona_doc_id = d.id);

UPDATE project_personas pp
   SET project_knowledge_doc_ids = pp.project_knowledge_doc_ids || ARRAY(
     SELECT pd.id FROM project_documents pd
       JOIN project_persona_documents d ON d.id = pd.migrated_from_persona_doc_id
      WHERE d.persona_id = pp.id AND NOT (pd.id = ANY(pp.project_knowledge_doc_ids)))
 WHERE EXISTS (SELECT 1 FROM project_persona_documents d WHERE d.persona_id = pp.id AND d.is_hidden_rubric = true);
