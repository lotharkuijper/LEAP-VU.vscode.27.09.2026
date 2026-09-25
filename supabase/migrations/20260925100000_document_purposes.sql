-- Bestandsdoelen (herinrichting docentenbeheer, 2026-09-25).
--
-- Elk bestand krijgt een DOEL dat bepaalt wie het ziet en wat de AI ermee doet:
--   course_material  Leerstof: RAG voor chat, Ik leg uit en quiz; bron voor begrippen.
--   course_info      Cursusinformatie (studiehandleiding, rooster): alleen chat,
--                    GEEN begrippenextractie, GEEN Ik-leg-uit/quiz-context.
--   shared           Alleen delen met studenten (downloads), geen AI.
--   teacher_only     Alleen voor docenten: nooit AI, nooit zichtbaar voor studenten.
-- Projectmateriaal blijft in project_documents (per project) en krijgt daar een
-- soort (material_kind).
--
-- Volledig ADDITIEF: de oude code negeert deze kolommen. NULL = nog niet
-- beoordeeld (eenmalige controle); de effectieve behandeling blijft dan zoals
-- voorheen (volgt uit map/bucket). Terugdraaien:
-- supabase/rollback/20260925100000_document_purposes_down.sql
BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS purpose text
    CHECK (purpose IS NULL OR purpose IN ('course_material','course_info','shared','teacher_only')),
  ADD COLUMN IF NOT EXISTS purpose_confirmed_at timestamptz;

ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS material_kind text
    CHECK (material_kind IS NULL OR material_kind IN ('assignment','data','literature','other'));

-- Studenten mogen 'teacher_only'-documenten niet zien (ook niet via
-- PostgREST): alleen admin en de docent van de cursus. De bytes van zulke
-- bestanden staan in documents.file_bytes (niet in storage, want storage-reads
-- zijn open voor elke ingelogde gebruiker).
DROP POLICY IF EXISTS "documents_read_staff_or_public_course" ON documents;
CREATE POLICY "documents_read_staff_or_public_course" ON documents
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
    OR (
      course_content_is_public(folder_course_id(folder_id))
      AND purpose IS DISTINCT FROM 'teacher_only'
    )
  );

COMMIT;
