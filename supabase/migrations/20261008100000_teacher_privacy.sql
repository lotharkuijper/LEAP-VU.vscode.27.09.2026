-- Privacy: docenten zien niets meer van wat studenten doen (2026-10-08).
--
-- Besluit van de eigenaar: een docent mag alleen zien
--   1. wie er in zijn/haar eigen cursus(sen) zit, en
--   2. wie er binnen die cursus(sen) in welke projectgroep zit.
-- Geen toegang tot leerdagboeken, quizpogingen en -scores, antwoorden, uitleg
-- bij Ik leg uit, projectsessies, groepschats, gesprekken met persona's,
-- tussenstanden, ingeleverd werk bij beoordelaars, oordelen, badges,
-- verstandhouding of door groepen geüploade bestanden, en geen profielen van
-- mensen buiten de eigen cursus(sen). Studenten kunnen zelf iets delen
-- (dat loopt dan via een eigen, bewuste handeling).
--
-- Daarnaast een beveiligingslek dicht: een gebruiker kon via de API zijn
-- eigen rol wijzigen (bv. naar 'admin'). Rolwijzigingen mogen nu alleen nog
-- door een beheerder of door de server (service role).
--
-- Alleen de LEES-regels (en de rol-regels van profiles) veranderen; gegevens
-- blijven ongemoeid. Beheerders (pr_is_admin) houden toegang tot groepsinhoud
-- voor ondersteuning. De server werkt met de service role en kijkt zelf naar
-- rechten (zie server/index.js: canSeeGroupContent).
-- Terugdraaien: supabase/rollback/20261008100000_teacher_privacy_down.sql
BEGIN;

-- ── Hulpfuncties ──────────────────────────────────────────────────────────────
-- Is de ingelogde gebruiker docent van een cursus waarin `target` zit?
CREATE OR REPLACE FUNCTION public.pr_teacher_can_see_profile(target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_members s
     WHERE s.user_id = target
       AND is_course_teacher(auth.uid(), s.course_id)
  );
$$;

-- Is de ingelogde gebruiker docent van de cursus waar deze projectgroep onder valt?
CREATE OR REPLACE FUNCTION public.pr_is_project_teacher_of_group(p_group_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_groups g JOIN projects p ON p.id = g.project_id
     WHERE g.id = p_group_id AND p.course_id IS NOT NULL
       AND is_course_teacher(auth.uid(), p.course_id)
  );
$$;

-- ── Persoonlijke leergegevens: alleen de student zelf ─────────────────────────
DROP POLICY IF EXISTS "Docents can view all journal entries" ON public.learning_journal_entries;
DROP POLICY IF EXISTS "Docenten and admin can read all attempts" ON public.quiz_attempts;
DROP POLICY IF EXISTS "Docenten and admin can read all answers" ON public.student_answers;
DROP POLICY IF EXISTS "Docenten and admin can read all explanations" ON public.student_explanations;
DROP POLICY IF EXISTS "Docenten and admin can read all sessions" ON public.student_project_sessions;

-- ── Groepsinhoud: alleen groepsleden (en beheerders) ──────────────────────────
DROP POLICY IF EXISTS gcm_select ON public.group_chat_messages;
CREATE POLICY gcm_select ON public.group_chat_messages FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS gpt_select ON public.group_persona_threads;
CREATE POLICY gpt_select ON public.group_persona_threads FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS gcp_select ON public.group_checkpoints;
CREATE POLICY gcp_select ON public.group_checkpoints FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS pdr_select ON public.project_document_reviews;
CREATE POLICY pdr_select ON public.project_document_reviews FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS prb_select ON public.project_review_badges;
CREATE POLICY prb_select ON public.project_review_badges FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS pgp_select ON public.project_group_products;
CREATE POLICY pgp_select ON public.project_group_products FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

DROP POLICY IF EXISTS ppr_select ON public.project_persona_relationships;
CREATE POLICY ppr_select ON public.project_persona_relationships FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin());

-- Persona-documenten: wat een GROEP uploadt is alleen voor die groep; wat de
-- docent bij een persona zet (group_id leeg, of een rubric) blijft voor de docent.
DROP POLICY IF EXISTS ppd_select ON public.project_persona_documents;
CREATE POLICY ppd_select ON public.project_persona_documents FOR SELECT TO authenticated
  USING (
    (is_hidden_rubric IS NOT TRUE AND group_id IS NOT NULL AND pr_is_group_member(group_id))
    OR ((group_id IS NULL OR is_hidden_rubric IS TRUE) AND EXISTS (
          SELECT 1 FROM projects p WHERE p.id = project_persona_documents.project_id AND pr_is_course_staff(p.course_id)))
    OR pr_is_admin()
  );

-- ── Wie zit in welke groep: groepsleden, docenten van die cursus, beheerders ──
DROP POLICY IF EXISTS project_groups_select ON public.project_groups;
CREATE POLICY project_groups_select ON public.project_groups FOR SELECT TO authenticated
  USING (pr_is_group_member(id) OR pr_is_admin() OR pr_is_project_teacher_of_group(id));

DROP POLICY IF EXISTS pgm_select ON public.project_group_members;
CREATE POLICY pgm_select ON public.project_group_members FOR SELECT TO authenticated
  USING (pr_is_group_member(group_id) OR pr_is_admin() OR pr_is_project_teacher_of_group(group_id));

-- ── Profielen: eigen profiel; docenten alleen van mensen in hun cursussen ─────
DROP POLICY IF EXISTS "Admin and docent can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS profiles_select_admin_or_own_course ON public.profiles;
CREATE POLICY profiles_select_admin_or_own_course ON public.profiles FOR SELECT TO authenticated
  USING (is_admin() OR pr_teacher_can_see_profile(id));

-- ── Rol alleen te wijzigen door een beheerder of de server ────────────────────
-- Deze regel controleerde niet welke velden je wijzigt (dus ook je rol); de
-- variant "Users can update own profile (not role)" blijft staan.
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
-- Profielen maakt de database zelf aan bij registratie (trigger op auth.users,
-- SECURITY DEFINER); een open insert-regel is niet nodig.
DROP POLICY IF EXISTS "Allow insert for new user registration" ON public.profiles;

CREATE OR REPLACE FUNCTION public.pr_guard_profile_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pr_guard_profile_role ON public.profiles;
CREATE TRIGGER pr_guard_profile_role BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.pr_guard_profile_role();

COMMIT;
