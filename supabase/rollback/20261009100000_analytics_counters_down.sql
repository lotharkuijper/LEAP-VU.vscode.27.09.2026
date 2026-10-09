-- TERUGDRAAIEN van 20261009100000_analytics_counters.sql.
-- Verwijdert de analytics-tellers. Er gaan alleen geaggregeerde tellingen
-- verloren; geen gegevens van gebruikers.
BEGIN;

DROP FUNCTION IF EXISTS public.analytics_bump(jsonb);
DROP TABLE IF EXISTS public.analytics_counters;

COMMIT;
