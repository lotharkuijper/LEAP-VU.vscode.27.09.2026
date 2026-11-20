-- Beeldoefeningen, stap 1: de docentkant (2026-11-20).
-- De docent uploadt foto's en beschrijvingen van wat er te zien is. LEAP koppelt
-- beschrijving en foto (de docent bevestigt) en maakt van elke beschrijving een
-- lijstje kenmerken (kern of extra, met waarneming en duiding).
--
-- De beschrijvingen en kenmerken zijn een ANTWOORDSLEUTEL: alleen de server leest
-- en schrijft deze tabellen (service role). Geen leesregel voor studenten of
-- docenten; docenten werken via de server, die per cursus controleert. De foto's
-- staan in de private opslagmap 'image_exercises' zonder regels op
-- storage.objects, dus ook daar alleen de server.
--
-- Terugdraaien: supabase/rollback/20261120100000_image_exercises_down.sql

CREATE TABLE IF NOT EXISTS public.image_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer,
  position integer NOT NULL DEFAULT 0,
  -- De beschrijving van de docent (vrije tekst) en hoe die gekoppeld is.
  description text,
  match_source text CHECK (match_source IN ('name', 'number', 'order', 'suggested', 'manual', 'typed')),
  description_confirmed_at timestamptz,
  -- Hoe diep de student moet gaan, en wat de student over het aantal kenmerken ziet.
  depth text NOT NULL DEFAULT 'describe' CHECK (depth IN ('name', 'describe', 'interpret')),
  count_display text NOT NULL DEFAULT 'approx' CHECK (count_display IN ('exact', 'approx', 'none')),
  -- Kenmerken: nog niet gemaakt, bezig, klaar, mislukt; 'uncertain' = LEAP vraagt de docent even te kijken.
  features_status text NOT NULL DEFAULT 'none' CHECK (features_status IN ('none', 'pending', 'ready', 'failed')),
  features_uncertain boolean NOT NULL DEFAULT false,
  features_note text,
  features_reviewed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS image_exercises_course ON public.image_exercises (course_id, position);

CREATE TABLE IF NOT EXISTS public.image_exercise_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id uuid NOT NULL REFERENCES public.image_exercises(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  observation text,
  interpretation text,
  is_core boolean NOT NULL DEFAULT true,
  open_interpretation boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'teacher')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS image_exercise_features_exercise ON public.image_exercise_features (exercise_id, position);

ALTER TABLE public.image_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_exercise_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_exercises FROM anon, authenticated;
REVOKE ALL ON public.image_exercise_features FROM anon, authenticated;

INSERT INTO storage.buckets (id, name, public)
VALUES ('image_exercises', 'image_exercises', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
