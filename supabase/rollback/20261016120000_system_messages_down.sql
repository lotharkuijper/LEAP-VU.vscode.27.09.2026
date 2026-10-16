-- Terugdraaien van 20261016120000_system_messages.sql: verwijdert de
-- systeemberichten en wie ze wegklikte.
BEGIN;

DROP TABLE IF EXISTS public.system_message_dismissals;
DROP TABLE IF EXISTS public.system_messages;

DELETE FROM public.leap_migrations WHERE name = '20261016120000_system_messages.sql';

COMMIT;

NOTIFY pgrst, 'reload schema';
