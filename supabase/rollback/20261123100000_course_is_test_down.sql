-- Terug naar de situatie van vóór 20261123100000_course_is_test: testcursussen worden
-- weer gewone cursussen (met hun inhoud); de bewaking op lidmaatschap verdwijnt.
DROP TRIGGER IF EXISTS leap_test_course_switch_check ON public.courses;
DROP TRIGGER IF EXISTS leap_test_course_members_only_admins ON public.course_members;
DO $$
BEGIN
  IF to_regclass('public.course_alumni') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS leap_test_course_alumni_only_admins ON public.course_alumni;
  END IF;
END $$;
DROP TRIGGER IF EXISTS leap_test_course_drop_former_admin ON public.profiles;
DROP FUNCTION IF EXISTS public.leap_test_course_drop_former_admin();
DROP FUNCTION IF EXISTS public.leap_test_course_switch_check();
DROP FUNCTION IF EXISTS public.leap_test_course_members_only_admins();
DROP FUNCTION IF EXISTS public.leap_user_is_admin(uuid);
ALTER TABLE public.courses DROP COLUMN IF EXISTS is_test;

NOTIFY pgrst, 'reload schema';
