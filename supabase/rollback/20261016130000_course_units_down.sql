-- Terugdraaien van 20261016130000_course_units.sql: verwijdert de leerlijn
-- (onderdelen en de koppeling van documenten). Documenten zelf blijven staan.
BEGIN;

DROP TABLE IF EXISTS public.course_unit_documents;
DROP TABLE IF EXISTS public.course_units;

DELETE FROM public.leap_migrations WHERE name = '20261016130000_course_units.sql';

COMMIT;

NOTIFY pgrst, 'reload schema';
