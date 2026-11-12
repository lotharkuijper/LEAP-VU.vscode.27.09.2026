-- Terug naar de situatie van vóór 20261112200000_quiz_sessions: de browser schrijft
-- een afgeronde quiz weer zelf in quiz_attempts (regel uit 20261015100000_course_features).
-- Let op: de oude browsercode nakijken hoort hier ook bij (git revert van de code).
DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts
  FOR INSERT TO authenticated
  WITH CHECK (student_id = auth.uid() AND leap_can_use_course(course_id)
              AND leap_course_feature_on(course_id, 'quiz'));

DROP TABLE IF EXISTS public.quiz_session_answers;
DROP TABLE IF EXISTS public.quiz_sessions;

NOTIFY pgrst, 'reload schema';
