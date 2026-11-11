-- Persona's van een project lezen (2026-11-11). Groepsleden lezen via de
-- database alleen de persona's waarmee ze praten (begeleider, rolspeler);
-- beoordelaars komen voor hen alleen via de server (projectruimte, chat als
-- wegwijzer bij inleveren, feedbackrondes), zonder hun instructies.
-- Staf van de cursus en beheerders lezen alles via hun eigen tak.
-- Terugdraaien: supabase/rollback/20261111200000_project_personas_select_talkers_down.sql

DROP POLICY IF EXISTS project_personas_select ON public.project_personas;
CREATE POLICY project_personas_select ON public.project_personas FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
    OR (
      COALESCE(project_personas.persona_type, 'conversational') <> 'evaluator'
      AND EXISTS (
        SELECT 1
          FROM project_groups g
          JOIN project_group_members m ON m.group_id = g.id
          JOIN projects p ON p.id = g.project_id
         WHERE g.project_id = project_personas.project_id
           AND m.user_id = auth.uid()
           AND p.status IS DISTINCT FROM 'draft'
      )
    )
    OR pr_is_admin()
  );
