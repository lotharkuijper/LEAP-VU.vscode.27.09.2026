-- Terugdraaien van 20261020100000_course_enrollment_mode.sql: zet de oude
-- toegangsregels terug ("actief en zichtbaar = open voor iedereen") en
-- verwijdert de toegangsroute en de aanmeldingen in afwachting.
-- Lidmaatschappen die bij de migratie zijn aangemaakt, blijven staan (onschadelijk).
BEGIN;

CREATE OR REPLACE FUNCTION public.course_content_is_public(p_course uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = p_course
       AND c.is_active = true
       AND c.student_visible = true
  );
$function$;

CREATE OR REPLACE FUNCTION public.sc_can_read_course(p_course_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    pr_is_admin()
    OR pr_is_course_teacher(p_course_id)
    OR EXISTS (
      SELECT 1 FROM courses c
       WHERE c.id = p_course_id
         AND c.is_active = true
         AND c.student_visible = true
    )
    OR EXISTS (
      SELECT 1
        FROM courses c
        JOIN course_members cm ON cm.course_id = c.id
       WHERE c.id = p_course_id
         AND c.is_active = false
         AND c.student_visible = true
         AND cm.user_id = auth.uid()
    );
$function$;

DROP POLICY IF EXISTS "Students see available courses, teachers see own" ON public.courses;
CREATE POLICY "Students see available courses, teachers see own" ON public.courses
  FOR SELECT TO authenticated
  USING (((is_active = true) AND (student_visible = true)) OR is_course_teacher(auth.uid(), id));

DROP FUNCTION IF EXISTS public.is_course_member(uuid);
DROP TABLE IF EXISTS public.pending_course_enrollments;
ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS courses_enrollment_mode_check;
ALTER TABLE public.courses DROP COLUMN IF EXISTS enrollment_mode;

DELETE FROM public.leap_migrations WHERE name = '20261020100000_course_enrollment_mode.sql';

COMMIT;

NOTIFY pgrst, 'reload schema';
