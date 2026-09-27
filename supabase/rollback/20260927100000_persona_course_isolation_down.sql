-- TERUGDRAAIEN van 20260927100000_persona_course_isolation.sql
-- ("val terug op de oude systematiek").
--
-- Zet de persona-policies exact terug zoals ze vóór 2026-09-27 live stonden.
-- LET OP: daarmee komen de lekken terug (elke docent mag persona's van elk
-- project wijzigen; elke docent leest alle persona-documenten; studenten
-- lezen de sjablonen).
BEGIN;

DROP POLICY IF EXISTS course_personas_select ON course_personas;
CREATE POLICY course_personas_select ON course_personas FOR SELECT TO authenticated
  USING (pr_user_has_course_access(course_id));
DROP POLICY IF EXISTS course_personas_modify ON course_personas;
CREATE POLICY course_personas_modify ON course_personas FOR ALL TO authenticated
  USING (pr_is_course_teacher(course_id))
  WITH CHECK (pr_is_course_teacher(course_id));

DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id AND pr_is_course_teacher(p.course_id)
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
       WHERE g.project_id = project_personas.project_id AND m.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS project_personas_modify ON project_personas;
CREATE POLICY project_personas_modify ON project_personas FOR ALL TO authenticated
  USING (pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'docent'))
  WITH CHECK (pr_is_admin() OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'docent'));

DROP POLICY IF EXISTS ppd_select ON project_persona_documents;
CREATE POLICY ppd_select ON project_persona_documents FOR SELECT TO authenticated
  USING (
    (
      is_hidden_rubric IS NOT TRUE
      AND group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM project_group_members pgm
         WHERE pgm.group_id = project_persona_documents.group_id AND pgm.user_id = auth.uid()
      )
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.id = auth.uid()
         AND (p.role = ANY (ARRAY['admin'::text, 'docent'::text]) OR p.email = 'l.d.j.kuijper@vu.nl'::text)
    )
  );

DROP FUNCTION IF EXISTS pr_is_course_staff(uuid);

COMMIT;
