-- Terugdraaien van 20261023100000_canvas_lti.sql: de Canvas-koppeling verdwijnt.
-- Accounts en lidmaatschappen die via Canvas zijn aangemaakt, blijven bestaan.
BEGIN;
DROP TABLE IF EXISTS public.lti_course_links;
DROP TABLE IF EXISTS public.lti_identities;
DELETE FROM public.leap_migrations WHERE name = '20261023100000_canvas_lti.sql';
COMMIT;
