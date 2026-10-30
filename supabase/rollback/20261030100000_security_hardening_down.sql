-- Terugdraaien van 20261030100000_security_hardening.sql: de regels zoals ze
-- daarvoor waren (inclusief de lekken die de migratie dichtte).
CREATE POLICY project_groups_insert ON public.project_groups
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY project_groups_update ON public.project_groups
  FOR UPDATE TO authenticated
  USING (pr_is_group_member(id) OR pr_is_admin())
  WITH CHECK (pr_is_group_member(id) OR pr_is_admin());
CREATE POLICY pgm_insert ON public.project_group_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS project_documents_select ON public.project_documents;
CREATE POLICY project_documents_select ON public.project_documents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm JOIN project_groups pg ON pg.id = pgm.group_id
      WHERE pg.project_id = project_documents.project_id AND pgm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND (p.role IN ('admin', 'docent') OR p.email = 'l.d.j.kuijper@vu.nl')
    )
  );

CREATE OR REPLACE FUNCTION public.pr_guard_profile_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller text := coalesce(auth.role(), '');
BEGIN
  IF caller IN ('authenticated', 'anon') AND NOT is_admin() THEN
    IF TG_OP = 'INSERT' AND coalesce(NEW.role, 'student') <> 'student' THEN
      RAISE EXCEPTION 'Alleen een beheerder kan een rol toekennen';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Alleen een beheerder kan een rol wijzigen';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DELETE FROM public.leap_migrations WHERE name = '20261030100000_security_hardening.sql';
