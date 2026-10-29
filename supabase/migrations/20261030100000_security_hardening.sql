-- Beveiligingsronde 2026-10-30 (docs/security/README.md). Terugdraaien:
-- supabase/rollback/20261030100000_security_hardening_down.sql
--
-- 1. Projectgroepen: elke ingelogde gebruiker kon via de database-API zelf een
--    groep in elk project maken, zich bij elke groep aanmelden of een groep naar
--    een ander project verhangen. De browser doet dat nooit zelf: aanmaken,
--    aansluiten en indelen gaan via de server (service role), met de controles
--    op cursus, groepsindeling en privacy. Daarom deze schrijfregels weg.
DROP POLICY IF EXISTS project_groups_insert ON public.project_groups;
DROP POLICY IF EXISTS project_groups_update ON public.project_groups;
DROP POLICY IF EXISTS pgm_insert ON public.project_group_members;

-- 2. Projectdocumenten: elke docent (globale rol) zag de documenten van elk
--    project, en groepsleden zagen ook verborgen documenten en de rubric. Nu:
--    beheerder, docent van DEZE cursus, of groepslid voor documenten die voor
--    studenten zichtbaar zijn en geen rubric zijn. (De browser leest deze tabel
--    niet zelf; de server gebruikt de service role.)
DROP POLICY IF EXISTS project_documents_select ON public.project_documents;
CREATE POLICY project_documents_select ON public.project_documents
  FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_documents.project_id AND pr_is_course_staff(p.course_id)
    )
    OR (
      is_visible_to_students
      AND coalesce(material_kind, '') <> 'rubric'
      AND EXISTS (
        SELECT 1
        FROM public.project_group_members pgm
        JOIN public.project_groups pg ON pg.id = pgm.group_id
        WHERE pg.project_id = project_documents.project_id AND pgm.user_id = auth.uid()
      )
    )
  );

-- 3. Profielen: het e-mailadres in profiles is waarop Canvas (LTI) en
--    uitnodigingen een bestaand account zoeken. Een gebruiker mocht het zelf
--    wijzigen en zo andermans Canvas-login naar zijn eigen account laten
--    wijzen. Nu: alleen beheerder of server wijzigt het; bij het aanmaken van
--    het eigen profiel moet het het eigen inlogadres zijn.
CREATE OR REPLACE FUNCTION public.pr_guard_profile_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller text := coalesce(auth.role(), '');
BEGIN
  -- Alleen verzoeken van ingelogde/anonieme gebruikers via de API worden
  -- bewaakt; de server (service_role) en database-triggers gaan door.
  IF caller IN ('authenticated', 'anon') AND NOT is_admin() THEN
    IF TG_OP = 'INSERT' AND coalesce(NEW.role, 'student') <> 'student' THEN
      RAISE EXCEPTION 'Alleen een beheerder kan een rol toekennen';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Alleen een beheerder kan een rol wijzigen';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.email IS NOT NULL
       AND lower(NEW.email) IS DISTINCT FROM lower(coalesce(auth.jwt() ->> 'email', '')) THEN
      RAISE EXCEPTION 'Het e-mailadres van een profiel is het eigen inlogadres';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Alleen een beheerder kan een e-mailadres wijzigen';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
