-- Beeldoefeningen, stap 2: het speelbord voor studenten (2026-11-21).
-- Per student en foto een poging: welke kenmerken al gevonden zijn (half of heel,
-- zelf of met een hint), welke hints gebruikt zijn en het gesprek met LEAP.
--
-- Alleen de server leest en schrijft (service role): de server kijkt na tegen de
-- antwoordsleutel (image_exercise_features), en de browser krijgt alleen de labels
-- van kenmerken die de student al gevonden heeft. Geen leesregel voor docenten:
-- docenten zien nooit wat een student doet (later alleen totalen).
-- progress: { "<feature-id>": { "state": "half" | "full", "how": "self" | "hint" } }
-- hints:    { "<feature-id>": <hoogste hintniveau 1-3> }
-- turns:    [ { "role": "student" | "leap", "text": "…", "at": "…" } ]
--
-- Terugdraaien: supabase/rollback/20261121100000_image_exercise_attempts_down.sql

CREATE TABLE IF NOT EXISTS public.image_exercise_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id uuid NOT NULL REFERENCES public.image_exercises(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  turns jsonb NOT NULL DEFAULT '[]'::jsonb,
  answers smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS image_exercise_attempts_user
  ON public.image_exercise_attempts (user_id, exercise_id, status, created_at DESC);

ALTER TABLE public.image_exercise_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_exercise_attempts FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
