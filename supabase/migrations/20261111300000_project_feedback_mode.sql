-- Wat de docent wil met feedback en beoordeling (besluit 2026-11-11): alleen
-- nakijkcommentaar voor zichzelf, feedback voor studenten, of allebei. De keuze
-- werd alleen in het scherm bijgehouden; nu bewaard, zodat de stap "Feedback en
-- beoordeling" eerlijk "aandacht nodig" toont als bij de keuze nog iets ontbreekt.
-- NULL = nog niet gekozen (bestaande projecten): de stap leidt het dan af uit de
-- beoordelaars die er al zijn, zoals voorheen.

BEGIN;

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS feedback_mode text;
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_feedback_mode_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_feedback_mode_check
  CHECK (feedback_mode IS NULL OR feedback_mode IN ('marking', 'both', 'feedback'));

COMMIT;
