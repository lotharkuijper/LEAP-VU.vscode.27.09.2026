-- Canvas-koppeling via LTI 1.3 (2026-10-23, server/lti.js).
--
-- 1. lti_identities: welk LEAP-account hoort bij welke Canvas-gebruiker
--    (uitgever + vast Canvas-id). Een e-mailadres kan veranderen, dit id niet.
--    Een account met een rij hier is "via Canvas geregistreerd" en mag zonder
--    wachtwoord inloggen met een code per e-mail.
-- 2. lti_course_links: vanuit welke Canvas-cursus een LEAP-cursus is geopend
--    (overzicht, en een vaste koppeling voor het cursusmenu in Canvas).
--
-- Alleen de server leest en schrijft (RLS aan, geen policies).
-- Terugdraaien: supabase/rollback/20261023100000_canvas_lti_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.lti_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_launch_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS lti_identities_user_idx ON public.lti_identities (user_id);
ALTER TABLE public.lti_identities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lti_course_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  context_id text NOT NULL,
  context_title text,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, context_id, course_id)
);
CREATE INDEX IF NOT EXISTS lti_course_links_course_idx ON public.lti_course_links (course_id);
ALTER TABLE public.lti_course_links ENABLE ROW LEVEL SECURITY;

COMMIT;
