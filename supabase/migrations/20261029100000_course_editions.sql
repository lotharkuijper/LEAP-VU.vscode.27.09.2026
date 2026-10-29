-- Edities van een cursus (2026-10-29). Zie server/courseEditions.js.
--
-- Een LEAP-cursus kan meerdere jaargangen (Canvas-cursussen) dienen. Met
-- "Nieuwe editie starten" begint de docent schoon zonder iets weg te gooien:
--   1. course_editions: wanneer een editie begon (en door wie).
--   2. course_alumni: oud-deelnemers van een vorige editie. Ze staan NIET meer
--      in course_members, dus ze vallen vanzelf weg uit ledenlijsten,
--      groepsindelingen, aankondigingen en systeemberichten. Ze houden wel
--      leestoegang (is_course_member en sc_can_read_course tellen ze mee), en
--      kunnen chat, Ik leg uit en de quiz blijven gebruiken.
--      Wordt iemand opnieuw lid (Canvas, uitnodiging, zelf aansluiten), dan
--      verdwijnt de alumni-rij vanzelf (trigger).
--   3. studiecafe_threads.archived_at: vragen van een vorige editie (gesloten,
--      standaard verborgen, apart te bekijken).
--   4. lti_course_links.retired_at: Canvas-cursussen van een vorige editie;
--      een klik daarvandaan maakt niemand (weer) actief lid of docent.
--   5. studiecafe_course_mutes: een student zet Studiecafé-mails van één
--      cursus uit.
--
-- Terugdraaien: supabase/rollback/20261029100000_course_editions_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.course_editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  label text,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS course_editions_course_idx ON public.course_editions(course_id, started_at DESC);
ALTER TABLE public.course_editions ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server leest en schrijft.

CREATE TABLE IF NOT EXISTS public.course_alumni (
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  former_role text NOT NULL DEFAULT 'student',
  edition_id uuid REFERENCES public.course_editions(id) ON DELETE SET NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS course_alumni_user_idx ON public.course_alumni(user_id);
ALTER TABLE public.course_alumni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS course_alumni_own ON public.course_alumni;
CREATE POLICY course_alumni_own ON public.course_alumni FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Opnieuw lid = geen oud-deelnemer meer (geldt voor elke route: Canvas,
-- uitnodiging, zelf aansluiten, beheer).
CREATE OR REPLACE FUNCTION public.course_members_clear_alumni()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  DELETE FROM course_alumni WHERE course_id = NEW.course_id AND user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS course_members_clear_alumni ON public.course_members;
CREATE TRIGGER course_members_clear_alumni AFTER INSERT ON public.course_members
  FOR EACH ROW EXECUTE FUNCTION public.course_members_clear_alumni();

ALTER TABLE public.studiecafe_threads ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.lti_course_links ADD COLUMN IF NOT EXISTS retired_at timestamptz;

CREATE TABLE IF NOT EXISTS public.studiecafe_course_mutes (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);
ALTER TABLE public.studiecafe_course_mutes ENABLE ROW LEVEL SECURITY;
-- Geen policies: de server leest en schrijft (alleen voor de ingelogde gebruiker zelf).

-- Lid of oud-deelnemer: leestoegang tot de cursus (materiaal, cursuslijst,
-- en via course_content_is_public/leap_can_use_course ook oefenen).
CREATE OR REPLACE FUNCTION public.is_course_member(p_course uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM course_members cm
     WHERE cm.course_id = p_course AND cm.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM course_alumni ca
     WHERE ca.course_id = p_course AND ca.user_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.sc_can_read_course(p_course_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    pr_is_admin()
    OR pr_is_course_teacher(p_course_id)
    OR EXISTS (
      SELECT 1
        FROM courses c
       WHERE c.id = p_course_id
         AND c.student_visible = true
         AND public.is_course_member(c.id)
    );
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
