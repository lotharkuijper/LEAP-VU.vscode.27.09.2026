-- Terugdraaien van 20261029100000_course_editions.sql.
-- Oud-deelnemers worden weer gewoon lid (in hun vroegere rol), gearchiveerde
-- Studiecafé-vragen blijven gesloten maar worden weer zichtbaar.
BEGIN;

INSERT INTO public.course_members (course_id, user_id, member_role, role)
SELECT course_id, user_id, former_role, former_role FROM public.course_alumni
ON CONFLICT (user_id, course_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_course_member(p_course uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = p_course AND cm.user_id = auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.sc_can_read_course(p_course_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
AS $function$
  SELECT pr_is_admin() OR pr_is_course_teacher(p_course_id) OR EXISTS (
    SELECT 1 FROM courses c JOIN course_members cm ON cm.course_id = c.id
     WHERE c.id = p_course_id AND c.student_visible = true AND cm.user_id = auth.uid());
$function$;

DROP TRIGGER IF EXISTS course_members_clear_alumni ON public.course_members;
DROP FUNCTION IF EXISTS public.course_members_clear_alumni();
DROP TABLE IF EXISTS public.studiecafe_course_mutes;
DROP TABLE IF EXISTS public.course_alumni;
DROP TABLE IF EXISTS public.course_editions;
ALTER TABLE public.studiecafe_threads DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.lti_course_links DROP COLUMN IF EXISTS retired_at;
DELETE FROM public.leap_migrations WHERE name = '20261029100000_course_editions.sql';

COMMIT;
NOTIFY pgrst, 'reload schema';
