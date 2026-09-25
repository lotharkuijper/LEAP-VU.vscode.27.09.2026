-- TERUGDRAAIEN van 20260925100000_document_purposes.sql
-- ("val terug op de oude systematiek").
--
-- Na dit script gedraagt de database zich weer exact als vóór de herinrichting:
--  * course_info-documenten zijn weer gewone leerstof (ze stonden altijd al in
--    de RAG-map van de cursus; alleen de kolom maakte het onderscheid);
--  * shared/teacher_only-bestanden blijven als gewone documents-rijen in hun
--    cursusmappen ("Gedeeld met studenten", "Alleen docenten") staan en zijn in
--    de oude Documenten-tab te zien en te downloaden (file_bytes wordt door
--    GET /api/admin/documents/:id/download al ondersteund).
--  * LET OP: de map "Alleen docenten" heeft folder_permissions student
--    can_view=false; de oude documents-RLS kijkt daar niet naar. Wil je na het
--    terugdraaien absoluut zeker zijn dat studenten die bestanden niet via de
--    API kunnen opvragen, verwijder ze dan of verplaats ze uit de cursus.
BEGIN;

DROP POLICY IF EXISTS "documents_read_staff_or_public_course" ON documents;
CREATE POLICY "documents_read_staff_or_public_course" ON documents
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
    OR course_content_is_public(folder_course_id(folder_id))
  );

ALTER TABLE project_documents DROP COLUMN IF EXISTS material_kind;
ALTER TABLE documents DROP COLUMN IF EXISTS purpose_confirmed_at;
ALTER TABLE documents DROP COLUMN IF EXISTS purpose;

COMMIT;
