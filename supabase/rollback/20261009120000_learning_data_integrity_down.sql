-- TERUGDRAAIEN van 20261009120000_learning_data_integrity.sql: de regels
-- zoals ze daarvoor waren. Gegevens blijven ongemoeid.
BEGIN;

DROP TRIGGER IF EXISTS quiz_attempt_rescore ON public.quiz_attempts;
DROP FUNCTION IF EXISTS public.quiz_attempt_rescore();

DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts
  FOR INSERT TO authenticated WITH CHECK (student_id = auth.uid());
DROP POLICY IF EXISTS "Students can update own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can update own attempts" ON public.quiz_attempts
  FOR UPDATE TO authenticated USING (student_id = auth.uid()) WITH CHECK (student_id = auth.uid());
DROP POLICY IF EXISTS "Students can delete own attempts" ON public.quiz_attempts;

DROP POLICY IF EXISTS "Users can create own journal entries" ON public.learning_journal_entries;
CREATE POLICY "Users can create own journal entries" ON public.learning_journal_entries
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own journal entries" ON public.learning_journal_entries;
CREATE POLICY "Users can update own journal entries" ON public.learning_journal_entries
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS student_course_levels_insert_own ON public.student_course_levels;
CREATE POLICY student_course_levels_insert_own ON public.student_course_levels
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS student_course_levels_update_own ON public.student_course_levels;
CREATE POLICY student_course_levels_update_own ON public.student_course_levels
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP FUNCTION IF EXISTS public.leap_can_use_course(uuid);

NOTIFY pgrst, 'reload schema';

COMMIT;
