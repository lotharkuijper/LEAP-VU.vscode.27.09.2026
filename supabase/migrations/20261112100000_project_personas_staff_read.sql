-- Persona's van een project lezen (2026-11-12). Hoe een persona is ingericht
-- (instructies, kennis, gedragsregels van een rolspeler) is voor de docent.
-- Studenten krijgen persona's alleen via de server (projectruimte, chat), die
-- daaruit weglaat wat voor de docent is. Direct uit de database lezen alleen
-- staf van de cursus en beheerders.
-- Voor de laatste-activiteit-tegel op het dashboard is er een kleine functie
-- die alleen naam van persona en project geeft, aan wie in een groep van dat
-- (open) project zit.
-- Terugdraaien: supabase/rollback/20261112100000_project_personas_staff_read_down.sql

DROP POLICY IF EXISTS project_personas_select ON public.project_personas;
CREATE POLICY project_personas_select ON public.project_personas FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_staff(p.course_id)
    )
    OR pr_is_admin()
  );

CREATE OR REPLACE FUNCTION public.pr_persona_label(p_persona_id uuid)
RETURNS TABLE (persona_name text, project_title text, course_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT pp.name::text, p.title::text, p.course_id
    FROM project_personas pp
    JOIN projects p ON p.id = pp.project_id
   WHERE pp.id = p_persona_id
     AND (
       pr_is_course_staff(p.course_id)
       OR pr_is_admin()
       OR (
         p.status IS DISTINCT FROM 'draft'
         AND EXISTS (
           SELECT 1
             FROM project_groups g
             JOIN project_group_members m ON m.group_id = g.id
            WHERE g.project_id = p.id
              AND m.user_id = auth.uid()
         )
       )
     );
$$;

REVOKE ALL ON FUNCTION public.pr_persona_label(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pr_persona_label(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
