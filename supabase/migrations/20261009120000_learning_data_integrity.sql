-- Integriteit van leergegevens die de browser zelf schrijft (2026-10-09).
--
-- Probleem: quizpogingen, dagboekregels en leerniveaus schrijft de browser
-- rechtstreeks. De regels controleerden alleen "het is je eigen rij":
--   * een quizscore kon elke waarde hebben, voor elke cursus, en achteraf
--     worden aangepast;
--   * een student kon door de server geschreven dagboekregels (leerniveau,
--     bewijs bij een prestatie) wijzigen;
--   * een cursus-id werd niet gecontroleerd.
--
-- Nu:
--   1. leap_can_use_course(): mag de ingelogde gebruiker deze cursus gebruiken
--      (zelfde regel als de server: open cursus, lid, docent of beheerder)?
--   2. quiz_attempts: nieuwe poging alleen voor een bruikbare cursus; de score
--      rekent de database zelf na (meerkeuze: antwoord tegen de sleutel; open
--      vragen: oordeel begrensd op 0–100); aanpassen achteraf kan niet meer;
--      verwijderen van je eigen poging wel (eigen sporen wissen).
--   3. learning_journal_entries: studenten maken en verwijderen hun eigen
--      regels, maar wijzigen ze niet meer (de browser deed dat nooit; de server
--      werkt met de service role en blijft dat kunnen).
--   4. student_course_levels: alleen voor een bruikbare cursus.
--
-- De server (service role) blijft overal ongemoeid.
-- Terugdraaien: supabase/rollback/20261009120000_learning_data_integrity_down.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.leap_can_use_course(p_course uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_course IS NULL
      OR course_content_is_public(p_course)
      OR pr_user_has_course_access(p_course)
      OR is_course_teacher(auth.uid(), p_course);
$$;

-- ── quiz_attempts ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts
  FOR INSERT TO authenticated
  WITH CHECK (student_id = auth.uid() AND leap_can_use_course(course_id));

DROP POLICY IF EXISTS "Students can update own attempts" ON public.quiz_attempts;

DROP POLICY IF EXISTS "Students can delete own attempts" ON public.quiz_attempts;
CREATE POLICY "Students can delete own attempts" ON public.quiz_attempts
  FOR DELETE TO authenticated
  USING (student_id = auth.uid());

-- Score narekenen bij elke poging die niet van de server komt.
CREATE OR REPLACE FUNCTION public.quiz_attempt_rescore()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  i integer;
  q jsonb;
  a jsonb;
  answered integer := 0;
  correct integer := 0;
  total numeric := 0;
  pct integer;
BEGIN
  IF current_user = 'service_role' OR coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.answers) = 'array' AND jsonb_typeof(NEW.questions_data) = 'array' THEN
    FOR i IN 0 .. jsonb_array_length(NEW.answers) - 1 LOOP
      a := NEW.answers -> i;
      q := NEW.questions_data -> i;
      CONTINUE WHEN a IS NULL OR jsonb_typeof(a) <> 'object';
      IF a ->> 'type' = 'mcq' THEN
        answered := answered + 1;
        IF q IS NOT NULL AND (a ->> 'selectedIndex') IS NOT NULL
           AND (a ->> 'selectedIndex') = (q ->> 'correctAnswer') THEN
          correct := correct + 1;
          total := total + 100;
        END IF;
      ELSIF jsonb_typeof(a -> 'evaluation') = 'object' AND (a -> 'evaluation' ->> 'score') ~ '^-?[0-9.]+$' THEN
        answered := answered + 1;
        total := total + greatest(0, least(100, (a -> 'evaluation' ->> 'score')::numeric));
      END IF;
    END LOOP;
    pct := CASE WHEN answered = 0 THEN 0 ELSE round(total / answered)::integer END;
    NEW.score_percentage := pct;
    NEW.score := CASE WHEN NEW.question_type = 'mcq' THEN correct ELSE pct END;
    NEW.total_questions := jsonb_array_length(NEW.questions_data);
  ELSE
    NEW.score_percentage := greatest(0, least(100, coalesce(NEW.score_percentage, 0)));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS quiz_attempt_rescore ON public.quiz_attempts;
CREATE TRIGGER quiz_attempt_rescore BEFORE INSERT ON public.quiz_attempts
  FOR EACH ROW EXECUTE FUNCTION public.quiz_attempt_rescore();

-- ── learning_journal_entries ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create own journal entries" ON public.learning_journal_entries;
CREATE POLICY "Users can create own journal entries" ON public.learning_journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND leap_can_use_course(course_id));

DROP POLICY IF EXISTS "Users can update own journal entries" ON public.learning_journal_entries;

-- ── student_course_levels ────────────────────────────────────────────────────
DROP POLICY IF EXISTS student_course_levels_insert_own ON public.student_course_levels;
CREATE POLICY student_course_levels_insert_own ON public.student_course_levels
  FOR INSERT WITH CHECK (auth.uid() = user_id AND leap_can_use_course(course_id));

DROP POLICY IF EXISTS student_course_levels_update_own ON public.student_course_levels;
CREATE POLICY student_course_levels_update_own ON public.student_course_levels
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND leap_can_use_course(course_id));

NOTIFY pgrst, 'reload schema';

COMMIT;
