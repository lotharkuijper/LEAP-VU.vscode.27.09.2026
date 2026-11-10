-- Terugdraaien van 20261111100000_project_draft.sql: de regels van vóór het
-- concept komen terug. Een project dat nog concept was, wordt 'archived' (niet
-- 'active'): anders zouden studenten een onaf project ineens zien. De docent zet
-- het zelf weer open als het klaar is.

BEGIN;

UPDATE public.projects SET status = 'archived' WHERE status = 'draft';

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('active', 'completed', 'archived'));

DROP POLICY IF EXISTS projects_course_member_select ON public.projects;
CREATE POLICY projects_course_member_select ON public.projects FOR SELECT TO authenticated
  USING (
    pr_is_course_teacher(course_id)
    OR (course_id IS NOT NULL AND pr_user_has_course_access(course_id))
  );

CREATE OR REPLACE FUNCTION pr_is_group_member(p_group_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

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
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
    )
    OR pr_is_admin()
  );

DROP POLICY IF EXISTS project_documents_select ON public.project_documents;
CREATE POLICY project_documents_select ON public.project_documents
  FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_documents.project_id AND pr_is_course_staff(p.course_id)
    )
    OR (
      is_visible_to_students
      AND coalesce(material_kind, '') <> 'rubric'
      AND EXISTS (
        SELECT 1
        FROM public.project_group_members pgm
        JOIN public.project_groups pg ON pg.id = pgm.group_id
        WHERE pg.project_id = project_documents.project_id AND pgm.user_id = auth.uid()
      )
    )
  );

COMMIT;
