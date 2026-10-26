-- Uitnodigingen voor een cursus door een docent (2026-10-26, server/courseInvitations.js).
--
-- Eén rij per (cursus, persoon). kind:
--   'new'   = er bestond nog geen account; LEAP maakte het aan en de persoon
--             activeert het via de link in de uitnodigingsmail (accepted_at).
--             Niet geactiveerd na 30 dagen: account en inschrijving worden opgeruimd.
--   'added' = bestaand account, direct ingeschreven; alleen een bericht per mail.
-- De mail gaat via een wachtrij (mail_status) die de mail-limiet respecteert.
-- invited_by legt vast wie uitnodigde (staat ook in de mail).
--
-- Alleen de server leest en schrijft (RLS aan, geen policies).
-- Terugdraaien: supabase/rollback/20261026120000_course_invitations_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.course_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new', 'added')),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  lang text NOT NULL DEFAULT 'nl',
  mail_status text NOT NULL DEFAULT 'queued' CHECK (mail_status IN ('queued', 'sent', 'failed')),
  mail_attempts integer NOT NULL DEFAULT 0,
  mail_error text,
  last_sent_at timestamptz,
  accepted_at timestamptz,
  UNIQUE (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS course_invitations_queue_idx ON public.course_invitations (invited_at) WHERE mail_status = 'queued';
CREATE INDEX IF NOT EXISTS course_invitations_inviter_idx ON public.course_invitations (invited_by, invited_at);
CREATE INDEX IF NOT EXISTS course_invitations_user_idx ON public.course_invitations (user_id);
ALTER TABLE public.course_invitations ENABLE ROW LEVEL SECURITY;

COMMIT;
