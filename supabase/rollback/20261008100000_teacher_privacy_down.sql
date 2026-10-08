-- TERUGDRAAIEN van 20261008100000_teacher_privacy.sql — automatisch gemaakt uit de
-- policies zoals ze op 2026-10-08 in de database stonden.
-- Zet alle SELECT/ALL/UPDATE/INSERT/DELETE-policies van deze tabellen exact terug.
BEGIN;

-- learning_journal_entries
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='learning_journal_entries' LOOP EXECUTE format('DROP POLICY %I ON public.learning_journal_entries', p.policyname); END LOOP; END $$;
CREATE POLICY "Docents can view all journal entries" ON public.learning_journal_entries AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['docent'::text, 'admin'::text]))))));
CREATE POLICY "Users can create own journal entries" ON public.learning_journal_entries AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete own journal entries" ON public.learning_journal_entries AS PERMISSIVE FOR DELETE TO "authenticated"
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own journal entries" ON public.learning_journal_entries AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own journal entries" ON public.learning_journal_entries AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((auth.uid() = user_id));

-- quiz_attempts
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='quiz_attempts' LOOP EXECUTE format('DROP POLICY %I ON public.quiz_attempts', p.policyname); END LOOP; END $$;
CREATE POLICY "Docenten and admin can read all attempts" ON public.quiz_attempts AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['docent'::text, 'admin'::text]))))));
CREATE POLICY "Students can create own attempts" ON public.quiz_attempts AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((student_id = auth.uid()));
CREATE POLICY "Students can read own attempts" ON public.quiz_attempts AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((student_id = auth.uid()));
CREATE POLICY "Students can update own attempts" ON public.quiz_attempts AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING ((student_id = auth.uid()))
  WITH CHECK ((student_id = auth.uid()));

-- student_answers
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='student_answers' LOOP EXECUTE format('DROP POLICY %I ON public.student_answers', p.policyname); END LOOP; END $$;
CREATE POLICY "Docenten and admin can read all answers" ON public.student_answers AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['docent'::text, 'admin'::text]))))));
CREATE POLICY "Students can insert own answers" ON public.student_answers AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM quiz_attempts
  WHERE ((quiz_attempts.id = student_answers.attempt_id) AND (quiz_attempts.student_id = auth.uid())))));
CREATE POLICY "Students can read own answers" ON public.student_answers AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM quiz_attempts
  WHERE ((quiz_attempts.id = student_answers.attempt_id) AND (quiz_attempts.student_id = auth.uid())))));

-- student_explanations
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='student_explanations' LOOP EXECUTE format('DROP POLICY %I ON public.student_explanations', p.policyname); END LOOP; END $$;
CREATE POLICY "Docenten and admin can read all explanations" ON public.student_explanations AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['docent'::text, 'admin'::text]))))));
CREATE POLICY "Students can create own explanations" ON public.student_explanations AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((student_id = auth.uid()));
CREATE POLICY "Students can read own explanations" ON public.student_explanations AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((student_id = auth.uid()));

-- student_project_sessions
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='student_project_sessions' LOOP EXECUTE format('DROP POLICY %I ON public.student_project_sessions', p.policyname); END LOOP; END $$;
CREATE POLICY "Docenten and admin can read all sessions" ON public.student_project_sessions AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['docent'::text, 'admin'::text]))))));
CREATE POLICY "Students can manage own sessions" ON public.student_project_sessions AS PERMISSIVE FOR ALL TO "authenticated"
  USING ((student_id = auth.uid()))
  WITH CHECK ((student_id = auth.uid()));
CREATE POLICY "Students can read own sessions" ON public.student_project_sessions AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((student_id = auth.uid()));

-- group_chat_messages
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='group_chat_messages' LOOP EXECUTE format('DROP POLICY %I ON public.group_chat_messages', p.policyname); END LOOP; END $$;
CREATE POLICY "gcm_insert" ON public.group_chat_messages AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((user_id = auth.uid()) AND pr_is_group_member(group_id)));
CREATE POLICY "gcm_select" ON public.group_chat_messages AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((pr_is_group_member(group_id) OR pr_is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'docent'::text))))));
CREATE POLICY "gcm_update" ON public.group_chat_messages AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (pr_is_group_member(group_id))
  WITH CHECK (pr_is_group_member(group_id));

-- group_persona_threads
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='group_persona_threads' LOOP EXECUTE format('DROP POLICY %I ON public.group_persona_threads', p.policyname); END LOOP; END $$;
CREATE POLICY "gpt_select" ON public.group_persona_threads AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((pr_is_group_member(group_id) OR pr_is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'docent'::text))))));

-- group_persona_messages
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='group_persona_messages' LOOP EXECUTE format('DROP POLICY %I ON public.group_persona_messages', p.policyname); END LOOP; END $$;
CREATE POLICY "gpm_select" ON public.group_persona_messages AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
   FROM group_persona_threads t
  WHERE ((t.id = group_persona_messages.thread_id) AND (pr_is_group_member(t.group_id) OR pr_is_admin())))));

-- group_checkpoints
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='group_checkpoints' LOOP EXECUTE format('DROP POLICY %I ON public.group_checkpoints', p.policyname); END LOOP; END $$;
CREATE POLICY "gcp_select" ON public.group_checkpoints AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((pr_is_group_member(group_id) OR pr_is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'docent'::text))))));

-- project_groups
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_groups' LOOP EXECUTE format('DROP POLICY %I ON public.project_groups', p.policyname); END LOOP; END $$;
CREATE POLICY "project_groups_insert" ON public.project_groups AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((auth.uid() = created_by));
CREATE POLICY "project_groups_select" ON public.project_groups AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((pr_is_group_member(id) OR pr_is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'docent'::text))))));
CREATE POLICY "project_groups_update" ON public.project_groups AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING ((pr_is_group_member(id) OR pr_is_admin()))
  WITH CHECK ((pr_is_group_member(id) OR pr_is_admin()));

-- project_group_members
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_group_members' LOOP EXECUTE format('DROP POLICY %I ON public.project_group_members', p.policyname); END LOOP; END $$;
CREATE POLICY "pgm_delete" ON public.project_group_members AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (((user_id = auth.uid()) OR pr_is_admin()));
CREATE POLICY "pgm_insert" ON public.project_group_members AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "pgm_select" ON public.project_group_members AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((pr_is_group_member(group_id) OR pr_is_admin() OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'docent'::text))))));

-- profiles
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='profiles' LOOP EXECUTE format('DROP POLICY %I ON public.profiles', p.policyname); END LOOP; END $$;
CREATE POLICY "Admin and docent can view all profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (is_admin_or_docent());
CREATE POLICY "Admin can update all profiles" ON public.profiles AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (is_admin())
  WITH CHECK (is_admin());
CREATE POLICY "Allow insert for new user registration" ON public.profiles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "Users can read their own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = id));
CREATE POLICY "Users can update own profile (not role)" ON public.profiles AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING ((auth.uid() = id))
  WITH CHECK (((auth.uid() = id) AND (role = ( SELECT profiles_1.role
   FROM profiles profiles_1
  WHERE (profiles_1.id = auth.uid())))));
CREATE POLICY "Users can update their own profile" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = id));
CREATE POLICY "Users can view own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((auth.uid() = id));

-- project_document_reviews
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_document_reviews' LOOP EXECUTE format('DROP POLICY %I ON public.project_document_reviews', p.policyname); END LOOP; END $$;
CREATE POLICY "pdr_select" ON public.project_document_reviews AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM project_group_members pgm
  WHERE ((pgm.group_id = project_document_reviews.group_id) AND (pgm.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (((project_groups pg
     JOIN projects p ON ((p.id = pg.project_id)))
     LEFT JOIN course_members cm ON (((cm.course_id = p.course_id) AND (cm.user_id = auth.uid()))))
     LEFT JOIN profiles pr ON ((pr.id = auth.uid())))
  WHERE ((pg.id = project_document_reviews.group_id) AND ((pr.role = 'admin'::text) OR (pr.email = 'l.d.j.kuijper@vu.nl'::text) OR (cm.member_role = 'teacher'::text)))))));

-- project_review_badges
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_review_badges' LOOP EXECUTE format('DROP POLICY %I ON public.project_review_badges', p.policyname); END LOOP; END $$;
CREATE POLICY "prb_select" ON public.project_review_badges AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM project_group_members pgm
  WHERE ((pgm.group_id = project_review_badges.group_id) AND (pgm.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (((project_groups pg
     JOIN projects p ON ((p.id = pg.project_id)))
     LEFT JOIN course_members cm ON (((cm.course_id = p.course_id) AND (cm.user_id = auth.uid()))))
     LEFT JOIN profiles pr ON ((pr.id = auth.uid())))
  WHERE ((pg.id = project_review_badges.group_id) AND ((pr.role = 'admin'::text) OR (pr.email = 'l.d.j.kuijper@vu.nl'::text) OR (cm.member_role = 'teacher'::text)))))));

-- project_group_products
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_group_products' LOOP EXECUTE format('DROP POLICY %I ON public.project_group_products', p.policyname); END LOOP; END $$;
CREATE POLICY "pgp_select" ON public.project_group_products AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((EXISTS ( SELECT 1
   FROM project_group_members m
  WHERE ((m.group_id = project_group_products.group_id) AND (m.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_group_products.project_id) AND pr_is_course_staff(p.course_id))))));

-- project_persona_relationships
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_persona_relationships' LOOP EXECUTE format('DROP POLICY %I ON public.project_persona_relationships', p.policyname); END LOOP; END $$;
CREATE POLICY "ppr_select" ON public.project_persona_relationships AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM (((project_groups pg
     JOIN projects p ON ((p.id = pg.project_id)))
     LEFT JOIN course_members cm ON (((cm.course_id = p.course_id) AND (cm.user_id = auth.uid()))))
     LEFT JOIN profiles pr ON ((pr.id = auth.uid())))
  WHERE ((pg.id = project_persona_relationships.group_id) AND ((pr.role = 'admin'::text) OR (pr.email = 'l.d.j.kuijper@vu.nl'::text) OR (cm.member_role = 'teacher'::text))))));

-- project_persona_documents
DO $$ DECLARE p record; BEGIN FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='project_persona_documents' LOOP EXECUTE format('DROP POLICY %I ON public.project_persona_documents', p.policyname); END LOOP; END $$;
CREATE POLICY "ppd_modify" ON public.project_persona_documents AS PERMISSIVE FOR ALL TO "authenticated"
  USING (false)
  WITH CHECK (false);
CREATE POLICY "ppd_select" ON public.project_persona_documents AS PERMISSIVE FOR SELECT TO "authenticated"
  USING ((((is_hidden_rubric IS NOT TRUE) AND (group_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM project_group_members pgm
  WHERE ((pgm.group_id = project_persona_documents.group_id) AND (pgm.user_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_persona_documents.project_id) AND pr_is_course_staff(p.course_id)))) OR pr_is_admin()));

DROP TRIGGER IF EXISTS pr_guard_profile_role ON public.profiles;
DROP FUNCTION IF EXISTS public.pr_guard_profile_role();
DROP FUNCTION IF EXISTS public.pr_teacher_can_see_profile(uuid);
DROP FUNCTION IF EXISTS public.pr_is_project_teacher_of_group(uuid);

COMMIT;
