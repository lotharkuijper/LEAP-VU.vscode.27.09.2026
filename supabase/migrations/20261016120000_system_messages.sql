-- Systeemberichten van de beheerder (2026-10-16).
--
-- De beheerder stuurt een bericht naar alle gebruikers, alle studenten, alle
-- docenten, of de leden van één cursus (alleen studenten of iedereen). Het
-- bericht staat op het Dashboard tot de gebruiker het wegklikt (of tot de
-- einddatum); bij "Dashboard" in het menu staat zolang een rood uitroepteken.
-- Eenrichtingsverkeer: er kan niet op gereageerd worden.
--
-- Alleen de server (service role) leest en schrijft; de server bepaalt per
-- gebruiker welke berichten voor hem zijn (server/systemMessages.js).
-- Privacy: per persoon wordt alleen bewaard DAT iemand een bericht wegklikte
-- (nodig om het niet opnieuw te tonen); de beheerder ziet daarvan alleen een
-- totaal.
--
-- Terugdraaien: supabase/rollback/20261016120000_system_messages_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.system_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'info' CHECK (kind IN ('info', 'warning')),
  audience text NOT NULL CHECK (audience IN ('all', 'students', 'teachers', 'course')),
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  course_role text CHECK (course_role IN ('students', 'all')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_messages_course_needs_id CHECK (audience <> 'course' OR course_id IS NOT NULL),
  CONSTRAINT system_messages_end_after_start CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS system_messages_active_idx ON public.system_messages (starts_at, ends_at);
ALTER TABLE public.system_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.system_message_dismissals (
  message_id uuid NOT NULL REFERENCES public.system_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS system_message_dismissals_user_idx ON public.system_message_dismissals (user_id);
ALTER TABLE public.system_message_dismissals ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server (service role) leest en schrijft.

COMMIT;

NOTIFY pgrst, 'reload schema';
