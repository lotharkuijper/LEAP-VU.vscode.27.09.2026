-- Project in concept (besluit 2026-11-11): een docent richt een project stap
-- voor stap in en probeert het zelf uit in een eigen testgroep. Studenten zien
-- een conceptproject niet tot de docent het opent voor studenten.
-- Bestaande projecten blijven 'active'; alleen nieuwe projecten starten als concept.

-- De oude check heeft een automatische naam: haal elke status-check weg.
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

-- Lezen: docent van de cursus (en beheerder) altijd; een cursuslid alleen als
-- het project niet meer in concept is.
DROP POLICY IF EXISTS projects_course_member_select ON public.projects;
CREATE POLICY projects_course_member_select ON public.projects FOR SELECT TO authenticated
  USING (
    pr_is_course_teacher(course_id)
    OR (course_id IS NOT NULL AND status IS DISTINCT FROM 'draft' AND pr_user_has_course_access(course_id))
  );
