-- Terugdraaien van 20261016140000_project_preassessment.sql: verwijdert de
-- voorbeoordelingen en de aanwijzing van de voorbeoordelaar. Inleveringen
-- zelf blijven staan.
BEGIN;

DROP TABLE IF EXISTS public.project_submission_assessments;
ALTER TABLE public.projects DROP COLUMN IF EXISTS preassessment_persona_id;

DELETE FROM public.leap_migrations WHERE name = '20261016140000_project_preassessment.sql';

COMMIT;

NOTIFY pgrst, 'reload schema';
