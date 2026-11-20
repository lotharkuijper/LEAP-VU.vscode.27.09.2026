-- Toegangsaanvragen van medewerkers (2026-11-22). Medewerkers van de VU en Amsterdam
-- UMC (@vu.nl, @amsterdamumc.nl) kunnen een account aanmaken zonder cursus. Zolang
-- ze in geen cursus zitten, kunnen ze de beheerder een vraag stellen, eventueel met
-- de cursussen waarin ze graag willen meekijken. De beheerder koppelt ze aan een
-- cursus (als docent of student) en sluit de aanvraag af.
--
-- Alleen de server leest en schrijft (service role); RLS aan zonder regels.
-- status: open (nog te doen) of closed (afgehandeld door de beheerder).
-- wished_course_ids: de cursussen die de aanvrager aanvinkte (alleen een wens).
-- granted_course_ids: de cursussen waaraan de beheerder de aanvrager koppelde.
--
-- Terugdraaien: supabase/rollback/20261122100000_access_requests_down.sql

CREATE TABLE IF NOT EXISTS public.access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message text NOT NULL DEFAULT '',
  wished_course_ids uuid[] NOT NULL DEFAULT '{}',
  role_wish text NOT NULL DEFAULT 'unsure' CHECK (role_wish IN ('teacher', 'student', 'unsure')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  granted_course_ids uuid[] NOT NULL DEFAULT '{}',
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_requests_status ON public.access_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS access_requests_user ON public.access_requests (user_id, created_at DESC);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.access_requests FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
