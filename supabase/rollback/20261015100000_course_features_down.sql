-- Terugdraaien van 20261015100000_course_features.sql.
-- Zet de aanmaakregels terug zoals ze waren, verwijdert de functie en de tabel
-- project_group_assessments.
-- De kolom courses.features blijft staan (onschadelijk; de oude code leest hem
-- niet). Wie hem echt weg wil: ALTER TABLE public.courses DROP COLUMN features;
BEGIN;

DROP POLICY IF EXISTS "Users can create own conversations" ON public.conversations;
CREATE POLICY "Users can create own conversations" ON public.conversations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts
  FOR INSERT TO authenticated
  WITH CHECK (student_id = auth.uid() AND leap_can_use_course(course_id));

DROP POLICY IF EXISTS "Users can create own journal entries" ON public.learning_journal_entries;
CREATE POLICY "Users can create own journal entries" ON public.learning_journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND leap_can_use_course(course_id));

DROP FUNCTION IF EXISTS public.leap_course_feature_on(uuid, text);

-- Beoordelingen in de projectruimte: de rapporten staan (als het dagboek aan
-- stond) ook in de leerdagboeken. Wie ze wil bewaren: eerst een momentopname
-- (scripts/db-snapshot.mjs … project_group_assessments).
DROP TABLE IF EXISTS public.project_group_assessments;

NOTIFY pgrst, 'reload schema';

COMMIT;
