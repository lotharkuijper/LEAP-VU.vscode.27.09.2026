-- Testcursus (2026-11-23). De beheerder kan een cursus tot testcursus maken: een
-- cursus om alles uit te proberen of een demo te geven, die alleen beheerders
-- kunnen bereiken. Toegang tot een cursus loopt via lidmaatschap (course_members);
-- daarom bewaakt de database hier dat in een testcursus alleen beheerders lid zijn.
--
--  * courses.is_test: true = testcursus.
--  * Een lidmaatschap (nieuw of gewijzigd) in een testcursus voor iemand die geen
--    beheerder is, wordt geweigerd (ook via Canvas, uitnodiging of open registratie).
--  * Een cursus wordt pas testcursus als er geen leden of oud-deelnemers zijn die
--    geen beheerder zijn.
-- Beheerder = profiles.role 'admin' of de hoofdbeheerder (zelfde regel als pr_is_admin).
--
-- Terugdraaien: supabase/rollback/20261123100000_course_is_test_down.sql

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Is deze gebruiker (niet de aanroeper) beheerder?
CREATE OR REPLACE FUNCTION public.leap_user_is_admin(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = p_user
       AND (role = 'admin' OR lower(email) = 'l.d.j.kuijper@vu.nl')
  );
$function$;
REVOKE ALL ON FUNCTION public.leap_user_is_admin(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.leap_test_course_members_only_admins()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM courses WHERE id = NEW.course_id AND is_test)
     AND NOT public.leap_user_is_admin(NEW.user_id) THEN
    RAISE EXCEPTION 'Alleen beheerders kunnen lid zijn van een testcursus'
      USING ERRCODE = 'P0001', HINT = 'leap_test_course';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS leap_test_course_members_only_admins ON public.course_members;
CREATE TRIGGER leap_test_course_members_only_admins
  BEFORE INSERT OR UPDATE OF user_id, course_id ON public.course_members
  FOR EACH ROW EXECUTE FUNCTION public.leap_test_course_members_only_admins();

-- Oud-deelnemers (course_alumni) houden leestoegang: dezelfde regel.
DO $$
BEGIN
  IF to_regclass('public.course_alumni') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS leap_test_course_alumni_only_admins ON public.course_alumni;
    CREATE TRIGGER leap_test_course_alumni_only_admins
      BEFORE INSERT OR UPDATE OF user_id, course_id ON public.course_alumni
      FOR EACH ROW EXECUTE FUNCTION public.leap_test_course_members_only_admins();
  END IF;
END $$;

-- Wie geen beheerder meer is, is ook geen lid of oud-deelnemer meer van een testcursus.
CREATE OR REPLACE FUNCTION public.leap_test_course_drop_former_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.leap_user_is_admin(NEW.id) THEN
    DELETE FROM course_members m USING courses c
     WHERE m.user_id = NEW.id AND m.course_id = c.id AND c.is_test;
    IF to_regclass('public.course_alumni') IS NOT NULL THEN
      DELETE FROM course_alumni a USING courses c
       WHERE a.user_id = NEW.id AND a.course_id = c.id AND c.is_test;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS leap_test_course_drop_former_admin ON public.profiles;
CREATE TRIGGER leap_test_course_drop_former_admin
  AFTER UPDATE OF role, email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.leap_test_course_drop_former_admin();

CREATE OR REPLACE FUNCTION public.leap_test_course_switch_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_test AND NOT COALESCE(OLD.is_test, false) THEN
    IF EXISTS (SELECT 1 FROM course_members m WHERE m.course_id = NEW.id AND NOT public.leap_user_is_admin(m.user_id))
       OR (to_regclass('public.course_alumni') IS NOT NULL
           AND EXISTS (SELECT 1 FROM course_alumni a WHERE a.course_id = NEW.id AND NOT public.leap_user_is_admin(a.user_id))) THEN
      RAISE EXCEPTION 'Deze cursus heeft nog leden die geen beheerder zijn'
        USING ERRCODE = 'P0001', HINT = 'leap_test_course_has_members';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS leap_test_course_switch_check ON public.courses;
CREATE TRIGGER leap_test_course_switch_check
  BEFORE UPDATE OF is_test ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.leap_test_course_switch_check();

NOTIFY pgrst, 'reload schema';
