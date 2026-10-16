-- Bijlagen in de chat (2026-10-16, docs/plans/chat-bijlagen-plan.html).
--
-- Studenten kunnen in de chat een afbeelding of bestand meegeven, alleen in
-- cursussen waar de docent dat bewust heeft aangezet en alleen als de
-- beheerder het platformbreed toestaat. LEAP bewaart de bijlagen NIET: ze
-- staan alleen in het geheugen van de browser zolang de chat open is.
--
-- 1. leap_course_feature_on: 'attachments' is een opt-in-onderdeel. Anders
--    dan de andere onderdelen staat het alleen aan bij {"attachments": true}.
-- 2. leap_setting_changes: wie zette wat wanneer aan of uit (docent per
--    cursus, beheerder platformbreed). Alleen de server schrijft en leest.
-- 3. Bewaking: berichten (messages) en het Studiecafé weigeren ingebedde
--    bestanden (data:…;base64,…). De browser schrijft chatberichten zelf weg;
--    zo kan een programmeerfout een bijlage nooit alsnog opslaan.
--
-- Terugdraaien: supabase/rollback/20261016100000_chat_attachments_down.sql
BEGIN;

-- ── 1. Opt-in-onderdeel ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leap_course_feature_on(p_course uuid, p_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_course IS NULL
      OR pr_is_admin()
      OR is_course_teacher(auth.uid(), p_course)
      OR coalesce(
           (SELECT CASE WHEN p_feature = ANY (ARRAY['attachments'])
                        THEN (c.features ->> p_feature) = 'true'
                        ELSE (c.features ->> p_feature) IS DISTINCT FROM 'false' END
              FROM courses c WHERE c.id = p_course),
           p_feature <> ALL (ARRAY['attachments']));
$$;

-- ── 2. Logboek van schakelaars ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leap_setting_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  setting text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leap_setting_changes_setting_idx
  ON public.leap_setting_changes (setting, created_at DESC);
ALTER TABLE public.leap_setting_changes ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server (service role) leest en schrijft.

-- ── 3. Geen ingebedde bestanden in berichten en Studiecafé ───────────────────
CREATE OR REPLACE FUNCTION public.leap_has_inline_file(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p, '') ~* 'data:[a-z0-9.+-]+/[a-z0-9.+-]+;base64,';
$$;

CREATE OR REPLACE FUNCTION public.leap_reject_inline_files()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    IF leap_has_inline_file(NEW.content) OR leap_has_inline_file(NEW.retrieved_context::text) THEN
      RAISE EXCEPTION 'Bijlagen worden niet bewaard' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF leap_has_inline_file(NEW.body) OR leap_has_inline_file(NEW.attachments::text) THEN
      RAISE EXCEPTION 'Bijlagen worden niet bewaard' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leap_messages_no_inline_files ON public.messages;
CREATE TRIGGER leap_messages_no_inline_files
  BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.leap_reject_inline_files();

DROP TRIGGER IF EXISTS leap_studiecafe_threads_no_inline_files ON public.studiecafe_threads;
CREATE TRIGGER leap_studiecafe_threads_no_inline_files
  BEFORE INSERT OR UPDATE ON public.studiecafe_threads
  FOR EACH ROW EXECUTE FUNCTION public.leap_reject_inline_files();

DROP TRIGGER IF EXISTS leap_studiecafe_replies_no_inline_files ON public.studiecafe_replies;
CREATE TRIGGER leap_studiecafe_replies_no_inline_files
  BEFORE INSERT OR UPDATE ON public.studiecafe_replies
  FOR EACH ROW EXECUTE FUNCTION public.leap_reject_inline_files();

COMMIT;

NOTIFY pgrst, 'reload schema';
