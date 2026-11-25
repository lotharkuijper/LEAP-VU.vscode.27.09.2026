-- Analytics per dag (2026-11-25): dezelfde tellers als analytics_counters,
-- maar per kalenderdag (Amsterdamse tijd) in plaats van per week. Nodig omdat
-- de activiteit tegen het einde van een cursus per dag sterk kan verschillen.
--
-- Privacy by design, net als analytics_counters: GEEN gebruikers, geen
-- tijdstippen, geen tekst. Alleen "hoe vaak", per dag, per cursus en per soort
-- (bv. "actieve studenten op 24-11: 31", "tokens voor de chat: 120.000").
-- Wie actief was, wordt alleen in het geheugen van de server ontdubbeld en
-- nooit opgeslagen.
--
-- Alleen de server schrijft en leest (service role); RLS staat aan zonder
-- policies. Terugdraaien: supabase/rollback/20261125100000_analytics_daily_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.analytics_daily (
  day date NOT NULL,
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  kind text NOT NULL,
  key text NOT NULL DEFAULT '',
  n bigint NOT NULL DEFAULT 0,
  total double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_unique UNIQUE NULLS NOT DISTINCT (day, course_id, kind, key)
);
CREATE INDEX IF NOT EXISTS analytics_daily_course_idx ON public.analytics_daily (course_id, day);
CREATE INDEX IF NOT EXISTS analytics_daily_kind_idx ON public.analytics_daily (kind, day);

ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;

-- Tellers ophogen in één aanroep: rows = [{day, course_id, kind, key, n, total}, …]
CREATE OR REPLACE FUNCTION public.analytics_bump_daily(rows jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; c integer := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    INSERT INTO analytics_daily AS a (day, course_id, kind, key, n, total)
    VALUES ((r->>'day')::date, NULLIF(r->>'course_id', '')::uuid, r->>'kind',
            left(coalesce(r->>'key', ''), 200), coalesce((r->>'n')::bigint, 0), coalesce((r->>'total')::double precision, 0))
    ON CONFLICT ON CONSTRAINT analytics_daily_unique
    DO UPDATE SET n = a.n + EXCLUDED.n, total = a.total + EXCLUDED.total, updated_at = now();
    c := c + 1;
  END LOOP;
  RETURN c;
END $$;

REVOKE ALL ON FUNCTION public.analytics_bump_daily(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.analytics_daily FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
