-- Terugdraaien van 20261111300000_project_feedback_mode.sql: de keuze leeft dan
-- weer alleen in het scherm (afgeleid uit de beoordelaars die er zijn).

BEGIN;

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_feedback_mode_check;
ALTER TABLE public.projects DROP COLUMN IF EXISTS feedback_mode;

COMMIT;
