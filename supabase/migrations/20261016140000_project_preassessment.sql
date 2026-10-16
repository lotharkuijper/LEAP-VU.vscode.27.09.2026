-- Voorbeoordeling van het eindproduct (2026-10-16).
--
-- Een docent kan per project één Beoordelaar aanwijzen als voorbeoordelaar
-- van het ingeleverde eindproduct (projects.preassessment_persona_id). Na
-- elke inlevering maakt LEAP met de verborgen rubric van die beoordelaar een
-- voorbeoordeling per criterium: sterke punten, aandachtspunten, korte citaten
-- en een indicatie. Geen cijfer: de docent beoordeelt.
--
-- De voorbeoordeling is alleen voor docenten van de cursus en LEAP-admins
-- (ingeleverd werk is bewust gedeeld met de docent). Studenten zien alleen
-- dát er een voorbeoordeling voor de docent wordt gemaakt.
--
-- Alleen de server (service role) leest en schrijft project_submission_assessments.
-- Terugdraaien: supabase/rollback/20261016140000_project_preassessment_down.sql
BEGIN;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS preassessment_persona_id uuid
    REFERENCES public.project_personas(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.project_submission_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES public.project_submissions(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.project_groups(id) ON DELETE CASCADE,
  persona_id uuid REFERENCES public.project_personas(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  content jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_submission_assessments_project_idx
  ON public.project_submission_assessments (project_id);
ALTER TABLE public.project_submission_assessments ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server leest en schrijft.

COMMIT;

NOTIFY pgrst, 'reload schema';
