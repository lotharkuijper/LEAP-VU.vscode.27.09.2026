-- Toegangsroute per cursus en open registratie (2026-10-20). Zie server/enrollment.js.
--
-- 1. courses.enrollment_mode: closed | canvas | open | canvas_open. Alle
--    bestaande cursussen worden 'open' (zolang er geen Canvas-toevoer is).
--    Alleen beheerders kunnen courses schrijven (RLS "Admins can manage all
--    courses"); de server stelt de route alleen in voor beheerders.
-- 2. pending_course_enrollments: cursussen die iemand bij open registratie
--    koos; ze worden lidmaatschappen bij de eerste login met een bevestigd
--    e-mailadres. Alleen de server leest en schrijft.
-- 3. Toegang = lidmaatschap. "Actief en zichtbaar = open voor iedereen" verdwijnt:
--    course_content_is_public, sc_can_read_course en de leesregel op courses
--    vragen nu om lidmaatschap (docenten en beheerders blijven toegang houden).
-- 4. Vooraf: iedereen die een cursus al gebruikte zonder lid te zijn, wordt lid,
--    zodat er voor huidige gebruikers niets verandert.
--
-- Terugdraaien: supabase/rollback/20261020100000_course_enrollment_mode_down.sql
BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS enrollment_mode text NOT NULL DEFAULT 'open';
ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS courses_enrollment_mode_check;
ALTER TABLE public.courses
  ADD CONSTRAINT courses_enrollment_mode_check
  CHECK (enrollment_mode IN ('closed', 'canvas', 'open', 'canvas_open'));

CREATE TABLE IF NOT EXISTS public.pending_course_enrollments (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);
ALTER TABLE public.pending_course_enrollments ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server leest en schrijft.

-- Is de huidige gebruiker lid van de cursus (student of docent)?
CREATE OR REPLACE FUNCTION public.is_course_member(p_course uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM course_members cm
     WHERE cm.course_id = p_course AND cm.user_id = auth.uid()
  );
$function$;

-- Vooraf: wie een cursus al gebruikte, wordt lid (niets verandert voor huidige gebruikers).
INSERT INTO public.course_members (course_id, user_id, member_role, role)
SELECT DISTINCT u.course_id, u.user_id, 'student', 'student'
  FROM (
    SELECT last_active_course_id AS course_id, id AS user_id FROM public.profiles WHERE last_active_course_id IS NOT NULL
    UNION SELECT course_id, user_id FROM public.conversations WHERE course_id IS NOT NULL
    UNION SELECT course_id, student_id FROM public.quiz_attempts WHERE course_id IS NOT NULL
    UNION SELECT course_id, user_id FROM public.learning_journal_entries WHERE course_id IS NOT NULL
    UNION SELECT course_id, user_id FROM public.student_course_levels WHERE course_id IS NOT NULL
  ) u
  JOIN public.courses c ON c.id = u.course_id
  JOIN auth.users au ON au.id = u.user_id
ON CONFLICT (user_id, course_id) DO NOTHING;

-- Inhoud van een cursus (documenten, fragmenten, en via leap_can_use_course het
-- wegschrijven van leergegevens): alleen voor leden van een actieve, zichtbare cursus.
-- De naam blijft, zodat alle bestaande regels die deze functie gebruiken meegaan.
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
  ) AND public.is_course_member(p_course);
$function$;

-- Studiecafé: leden van een zichtbare cursus (actief of gearchiveerd), docenten, beheerders.
CREATE OR REPLACE FUNCTION public.sc_can_read_course(p_course_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    pr_is_admin()
    OR pr_is_course_teacher(p_course_id)
    OR EXISTS (
      SELECT 1
        FROM courses c
        JOIN course_members cm ON cm.course_id = c.id
       WHERE c.id = p_course_id
         AND c.student_visible = true
         AND cm.user_id = auth.uid()
    );
$function$;

-- Cursuslijst: studenten zien alleen actieve, zichtbare cursussen waarvan ze lid zijn.
-- Open cursussen om je bij aan te sluiten komen via de server (/api/courses/open).
DROP POLICY IF EXISTS "Students see available courses, teachers see own" ON public.courses;
CREATE POLICY "Students see available courses, teachers see own" ON public.courses
  FOR SELECT TO authenticated
  USING (((is_active = true) AND (student_visible = true) AND public.is_course_member(id)) OR is_course_teacher(auth.uid(), id));

COMMIT;

NOTIFY pgrst, 'reload schema';
