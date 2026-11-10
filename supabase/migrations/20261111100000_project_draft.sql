-- Project in concept (besluit 2026-11-11): een docent richt een project stap
-- voor stap in en probeert het zelf uit in een eigen testgroep. Studenten zien
-- een conceptproject niet tot de docent het opent voor studenten, ook niet als
-- ze al in een groep zijn gezet (door de docent of via Canvas).
-- Bestaande projecten blijven 'active'; alleen nieuwe projecten starten als concept.

BEGIN;

-- 1. Status 'draft'. De oude check heeft een automatische naam: haal elke status-check weg.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.projects'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.projects DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('draft', 'active', 'completed', 'archived'));

-- 2. Het project zelf: staf van de cursus (docent van de cursus of beheerder)
--    altijd; een cursuslid alleen als het project niet meer in concept is.
DROP POLICY IF EXISTS projects_course_member_select ON public.projects;
CREATE POLICY projects_course_member_select ON public.projects FOR SELECT TO authenticated
  USING (
    pr_is_course_staff(course_id)
    OR (course_id IS NOT NULL AND status IS DISTINCT FROM 'draft' AND pr_user_has_course_access(course_id))
  );

-- 3. Groepslid: in een concept telt alleen staf van de cursus als lid (de eigen
--    testgroep). Alle regels op groepsinhoud (groepschat, gesprekken, bestanden,
--    leden) lopen via deze functie. Zelfde regel als isGroupMember op de server.
CREATE OR REPLACE FUNCTION pr_is_group_member(p_group_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM project_group_members m
      JOIN project_groups g ON g.id = m.group_id
      JOIN projects p ON p.id = g.project_id
     WHERE m.group_id = p_group_id AND m.user_id = auth.uid()
       AND (p.status IS DISTINCT FROM 'draft' OR pr_is_course_staff(p.course_id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public';

-- 4. Persona's en documenten van een project: de tak voor groepsleden alleen als
--    het project niet in concept is (staf en beheerder lezen via hun eigen tak).
DROP POLICY IF EXISTS project_personas_select ON public.project_personas;
CREATE POLICY project_personas_select ON public.project_personas FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
        JOIN projects p ON p.id = g.project_id
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
         AND p.status IS DISTINCT FROM 'draft'
    )
    OR pr_is_admin()
  );

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
        JOIN public.projects p ON p.id = pg.project_id
        WHERE pg.project_id = project_documents.project_id AND pgm.user_id = auth.uid()
          AND p.status IS DISTINCT FROM 'draft'
      )
    )
  );

COMMIT;
