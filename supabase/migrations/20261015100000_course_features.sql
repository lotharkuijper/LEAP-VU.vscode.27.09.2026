-- Onderdelen per cursus aan/uit (2026-10-15).
--
-- Een docent kan per cursus kiezen welke onderdelen studenten gebruiken:
-- chat, explain (Ik leg uit), quiz, projects, journal (leerdagboek) en
-- studiecafe. courses.features bewaart alleen wat UIT staat
-- ({"quiz": false}); een ontbrekende sleutel betekent aan, zodat bestaande
-- cursussen niets merken en een later toegevoegd onderdeel vanzelf aan staat.
--
-- Uitzetten is verbergen, niet wissen: bestaande gesprekken, pogingen en
-- dagboekregels blijven bewaard en komen terug zodra het onderdeel weer aan
-- gaat. Docenten van de cursus en beheerders blijven alles gebruiken (om voor
-- te bereiden en te testen).
--
-- De browser schrijft gesprekken, quizpogingen en dagboekregels zelf, dus de
-- database controleert de schakelaar bij het aanmaken. De server (service
-- role) controleert zelf (server/courseFeatures.js).
--
-- Terugdraaien: supabase/rollback/20261015100000_course_features_down.sql
BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Staat dit onderdeel in deze cursus aan voor de ingelogde gebruiker?
-- Geen cursus = geen schakelaar (oude rijen zonder course_id blijven werken).
CREATE OR REPLACE FUNCTION public.leap_course_feature_on(p_course uuid, p_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_course IS NULL
      OR pr_is_admin()
      OR is_course_teacher(auth.uid(), p_course)
      OR coalesce(
           (SELECT (c.features ->> p_feature) IS DISTINCT FROM 'false'
              FROM courses c WHERE c.id = p_course),
           true);
$$;

-- ── conversations (Chat) ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create own conversations" ON public.conversations;
CREATE POLICY "Users can create own conversations" ON public.conversations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND leap_course_feature_on(course_id, 'chat'));

-- ── quiz_attempts (Quiz) ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts
  FOR INSERT TO authenticated
  WITH CHECK (student_id = auth.uid() AND leap_can_use_course(course_id)
              AND leap_course_feature_on(course_id, 'quiz'));

-- ── learning_journal_entries (Leerdagboek) ───────────────────────────────────
DROP POLICY IF EXISTS "Users can create own journal entries" ON public.learning_journal_entries;
CREATE POLICY "Users can create own journal entries" ON public.learning_journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND leap_can_use_course(course_id)
              AND leap_course_feature_on(course_id, 'journal'));

-- ── Beoordelingen van de Beoordelaar in de projectruimte ─────────────────────
-- "Beoordeling opvragen" schreef het rapport alleen in de leerdagboeken. Nu
-- staat het ook bij de groep, zodat het zichtbaar blijft als het dagboek uit
-- staat. Groepsinhoud: alleen groepsleden en LEAP-beheerders lezen (zelfde
-- regel als group_checkpoints, migratie 20261008100000_teacher_privacy);
-- schrijven doet alleen de server.
CREATE TABLE IF NOT EXISTS public.project_group_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.project_groups(id) ON DELETE CASCADE,
  persona_id uuid REFERENCES public.project_personas(id) ON DELETE SET NULL,
  persona_name text NOT NULL DEFAULT '',
  persona_emoji text,
  request_id text,
  content text NOT NULL,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_group_assessments_group_idx
  ON public.project_group_assessments (group_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS project_group_assessments_request_idx
  ON public.project_group_assessments (group_id, persona_id, request_id) WHERE request_id IS NOT NULL;

ALTER TABLE public.project_group_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pga_select ON public.project_group_assessments;
CREATE POLICY pga_select ON public.project_group_assessments FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

NOTIFY pgrst, 'reload schema';

COMMIT;
