-- Terugdraaien van 20261026120000_course_invitations.sql.
-- Accounts en inschrijvingen die via een uitnodiging zijn gemaakt blijven bestaan;
-- alleen de administratie van de uitnodigingen (en de wachtrij) verdwijnt.
BEGIN;
DROP TABLE IF EXISTS public.course_invitations;
DELETE FROM public.leap_migrations WHERE name = '20261026120000_course_invitations.sql';
COMMIT;
