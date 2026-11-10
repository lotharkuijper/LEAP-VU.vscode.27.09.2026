-- Terugdraaien van 20261111100000_project_draft.sql: conceptprojecten worden
-- gewone (actieve) projecten en studenten zien weer alle projecten van hun cursus.

UPDATE public.projects SET status = 'active' WHERE status = 'draft';

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('active', 'completed', 'archived'));

DROP POLICY IF EXISTS projects_course_member_select ON public.projects;
CREATE POLICY projects_course_member_select ON public.projects FOR SELECT TO authenticated
  USING (
    pr_is_course_teacher(course_id)
    OR (course_id IS NOT NULL AND pr_user_has_course_access(course_id))
  );
