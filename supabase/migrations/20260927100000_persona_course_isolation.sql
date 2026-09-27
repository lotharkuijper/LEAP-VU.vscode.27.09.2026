-- Persona's strikt per cursus (herinrichting docentenbeheer, 2026-09-27).
--
-- Persona's worden alleen in de projectruimte gebruikt en horen, net als
-- itembanken, bij één cursus. Deze migratie dicht drie lekken in de RLS:
--   1. project_personas_modify gaf ELKE docent (globale rol) schrijfrecht op
--      de persona's van ELK project, ook in andere cursussen;
--   2. ppd_select gaf elke docent/admin leesrecht op alle persona-documenten,
--      inclusief verborgen rubrics van andere cursussen;
--   3. course_personas_select liet elke deelnemer van de cursus (ook
--      studenten) de sjablonen lezen, met volledige systeemprompts en
--      beoordelaarsinstructies.
--
-- "Staf van de cursus" = admin of course_members.member_role = 'teacher' voor
-- DIE cursus — dezelfde regel als isStaffForCourse op de server en als
-- is_course_teacher() in de documents-RLS. pr_is_course_teacher() (dat de
-- globale rol 'docent' vereist) blijft ongewijzigd voor bestaande policies.
--
-- Terugdraaien: supabase/rollback/20260927100000_persona_course_isolation_down.sql
BEGIN;

CREATE OR REPLACE FUNCTION pr_is_course_staff(p_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT pr_is_admin() OR (p_course_id IS NOT NULL AND is_course_teacher(auth.uid(), p_course_id));
$$;

-- 1. Sjablonen: alleen staf van de cursus leest en schrijft.
DROP POLICY IF EXISTS course_personas_select ON course_personas;
CREATE POLICY course_personas_select ON course_personas FOR SELECT TO authenticated
  USING (pr_is_course_staff(course_id));
DROP POLICY IF EXISTS course_personas_modify ON course_personas;
CREATE POLICY course_personas_modify ON course_personas FOR ALL TO authenticated
  USING (pr_is_course_staff(course_id))
  WITH CHECK (pr_is_course_staff(course_id));

-- 2. Persona's in een project: lezen door groepsleden van dat project (de
--    projectruimte) en staf van de cursus van het project; schrijven alleen
--    door staf van die cursus.
DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
    )
    OR pr_is_admin()
  );
DROP POLICY IF EXISTS project_personas_modify ON project_personas;
CREATE POLICY project_personas_modify ON project_personas FOR ALL TO authenticated
  USING (
    pr_is_admin() OR EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
  )
  WITH CHECK (
    pr_is_admin() OR EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
  );

-- 3. Persona-documenten: groepsleden zien hun eigen, niet-verborgen
--    documenten (ongewijzigd); staf alleen die van projecten in hun cursus.
--    Schrijven blijft uitsluitend via de server (ppd_modify = false).
DROP POLICY IF EXISTS ppd_select ON project_persona_documents;
CREATE POLICY ppd_select ON project_persona_documents FOR SELECT TO authenticated
  USING (
    (
      is_hidden_rubric IS NOT TRUE
      AND group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM project_group_members pgm
         WHERE pgm.group_id = project_persona_documents.group_id
           AND pgm.user_id = auth.uid()
      )
    )
    OR EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_persona_documents.project_id
         AND pr_is_course_staff(p.course_id)
    )
    OR pr_is_admin()
  );

COMMIT;
