-- TERUGDRAAIEN van 20261125100000_analytics_daily.sql.
-- Verwijdert de dagtellers. Er gaan alleen geaggregeerde tellingen verloren;
-- geen gegevens van gebruikers. De weektellers (analytics_counters) blijven.
BEGIN;

DROP FUNCTION IF EXISTS public.analytics_bump_daily(jsonb);
DROP TABLE IF EXISTS public.analytics_daily;

NOTIFY pgrst, 'reload schema';

COMMIT;
