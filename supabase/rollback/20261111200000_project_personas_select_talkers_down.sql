-- Terug naar de leesregel van 20261111100000_project_draft (stap 4).
DROP POLICY IF EXISTS project_personas_select ON public.project_personas;
CREATE POLICY project_personas_select ON public.project_personas FOR SELECT TO authenticated
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
        JOIN projects p ON p.id = g.project_id
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
         AND p.status IS DISTINCT FROM 'draft'
    )
    OR pr_is_admin()
  );
