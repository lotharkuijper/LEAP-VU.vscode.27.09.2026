-- Quiz nagekeken door de server (2026-11-12). De server maakt en controleert de
-- vragen, bewaart de antwoordsleutel in een quizsessie en kijkt elk antwoord na.
-- De browser krijgt een vraag pas met antwoord en uitleg te zien nadat de student
-- heeft geantwoord. Zo berusten de quizbadges (medaille, onder de knie,
-- herkansing gelukt) op resultaten die de student niet zelf kan aanpassen.
--
-- quiz_sessions: alleen de server leest en schrijft (service role); geen
-- leesregel voor studenten of docenten. Wat de student van een afgeronde quiz
-- terugziet, staat zoals voorheen in quiz_attempts (die schrijft nu de server).
-- quiz_session_answers: één rij per beantwoorde vraag; het eerste antwoord telt
-- (primaire sleutel sessie + vraag), ook als er twee tegelijk binnenkomen.
-- Verwijdert de student een afgeronde quiz (quiz_attempts), dan verdwijnt de
-- sessie mee (ON DELETE CASCADE); niet afgemaakte sessies ruimt de server na een dag op.
-- concept_results: per begrip { "<concept-id>": { "total": n, "pct": n } }.
--
-- Terugdraaien: supabase/rollback/20261112200000_quiz_sessions_down.sql

CREATE TABLE IF NOT EXISTS public.quiz_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  concept_ids uuid[] NOT NULL DEFAULT '{}',
  topics text[] NOT NULL DEFAULT '{}',
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_type text NOT NULL CHECK (question_type IN ('mcq', 'open', 'casus')),
  questions jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  score_percentage smallint,
  concept_results jsonb,
  attempt_id uuid REFERENCES public.quiz_attempts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS quiz_sessions_user_course
  ON public.quiz_sessions (user_id, course_id, status, finished_at DESC);

CREATE TABLE IF NOT EXISTS public.quiz_session_answers (
  session_id uuid NOT NULL REFERENCES public.quiz_sessions(id) ON DELETE CASCADE,
  question_index smallint NOT NULL CHECK (question_index >= 0),
  answer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, question_index)
);

ALTER TABLE public.quiz_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_session_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quiz_sessions FROM anon, authenticated;
REVOKE ALL ON public.quiz_session_answers FROM anon, authenticated;

-- Een afgeronde quiz schrijft de server in quiz_attempts; de browser niet meer.
DROP POLICY IF EXISTS "Students can create own attempts" ON public.quiz_attempts;

NOTIFY pgrst, 'reload schema';
