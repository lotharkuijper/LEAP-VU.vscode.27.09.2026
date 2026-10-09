-- Analytics: geaggregeerde tellers over het gebruik van LEAP (2026-10-09).
--
-- Privacy by design: deze tabel kent GEEN gebruikers. Er staat alleen in
-- hoe vaak iets gebeurde, per week, per cursus en per soort (bv. "chatvragen
-- over Confounding zonder goed bewijs: 7", "tokens voor de quiz: 120.000").
-- Geen tijdstippen, geen tekst van vragen, geen user-id's. Daarmee is deze
-- tabel nooit naar een persoon te herleiden.
--
-- Alleen de server schrijft en leest (service role); RLS staat aan zonder
-- policies, dus via de publieke API is er niets te zien.
--
-- Losse module: hoort bij server/analytics/. Terugdraaien (en analytics uit
-- LEAP verwijderen): supabase/rollback/20261009100000_analytics_counters_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.analytics_counters (
  week date NOT NULL,
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  kind text NOT NULL,
  key text NOT NULL DEFAULT '',
  n bigint NOT NULL DEFAULT 0,
  total double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_counters_unique UNIQUE NULLS NOT DISTINCT (week, course_id, kind, key)
);
CREATE INDEX IF NOT EXISTS analytics_counters_course_idx ON public.analytics_counters (course_id, week);
CREATE INDEX IF NOT EXISTS analytics_counters_kind_idx ON public.analytics_counters (kind, week);

ALTER TABLE public.analytics_counters ENABLE ROW LEVEL SECURITY;

-- Tellers ophogen in één aanroep: rows = [{week, course_id, kind, key, n, total}, …]
CREATE OR REPLACE FUNCTION public.analytics_bump(rows jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; c integer := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    INSERT INTO analytics_counters AS a (week, course_id, kind, key, n, total)
    VALUES ((r->>'week')::date, NULLIF(r->>'course_id', '')::uuid, r->>'kind',
            left(coalesce(r->>'key', ''), 200), coalesce((r->>'n')::bigint, 0), coalesce((r->>'total')::double precision, 0))
    ON CONFLICT ON CONSTRAINT analytics_counters_unique
    DO UPDATE SET n = a.n + EXCLUDED.n, total = a.total + EXCLUDED.total, updated_at = now();
    c := c + 1;
  END LOOP;
  RETURN c;
END $$;

REVOKE ALL ON FUNCTION public.analytics_bump(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.analytics_counters FROM anon, authenticated;

-- De API (PostgREST) moet de nieuwe tabel en functie zien.
NOTIFY pgrst, 'reload schema';

COMMIT;
