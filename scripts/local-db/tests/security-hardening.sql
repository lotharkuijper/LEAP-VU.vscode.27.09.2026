-- RLS checks for supabase/migrations/20261030100000_security_hardening.sql.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction.
-- Every check writes a row to a temp table; the end prints PASS/FAIL per check
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
-- fixtures: project in course A, a group with student1, three documents
insert into public.projects (id, title, research_question, course_id) values
  ('00000000-0000-0000-0000-0000000f0001', 'P', 'Q', '00000000-0000-0000-0000-0000000c0a01');
insert into public.project_groups (id, project_id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-0000000f0001', 'G1', 'ABC123', '00000000-0000-0000-0000-00000000c001');
insert into public.project_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000c001');
insert into public.project_documents (project_id, filename, is_visible_to_students, material_kind) values
  ('00000000-0000-0000-0000-0000000f0001', 'zichtbaar.pdf', true, 'literature'),
  ('00000000-0000-0000-0000-0000000f0001', 'verborgen.pdf', false, 'literature'),
  ('00000000-0000-0000-0000-0000000f0001', 'rubric.pdf', true, 'rubric');
-- a second teacher who is 'docent' globally but not in course A
insert into public.course_members (course_id, user_id, role, member_role) values
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000d001', 'teacher', 'teacher');
update public.profiles set role = 'docent' where id = '00000000-0000-0000-0000-00000000d001';

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

-- helper: run a statement as a user and record whether it was allowed
create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1. student2 (no member) cannot create a group in the project or join G1
select pg_temp.as_user('00000000-0000-0000-0000-00000000c002', 'student2@leap.local');
do $$ begin
  begin
    insert into public.project_groups (project_id, name, invite_code, created_by) values ('00000000-0000-0000-0000-0000000f0001', 'X', 'ZZZ999', auth.uid());
    insert into results values ('student cannot insert project_groups', false);
  exception when others then insert into results values ('student cannot insert project_groups', true); end;
  begin
    insert into public.project_group_members (group_id, user_id) values ('00000000-0000-0000-0000-0000000f0101', auth.uid());
    insert into results values ('student cannot join a group directly', false);
  exception when others then insert into results values ('student cannot join a group directly', true); end;
end $$;
reset role;

-- 2. member student1 sees only the visible non-rubric document; cannot move the group
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'member sees only visible non-rubric docs', array_agg(filename order by filename) = array['zichtbaar.pdf'] from public.project_documents;
update public.project_groups set project_id = project_id where id = '00000000-0000-0000-0000-0000000f0101';
insert into results select 'member update on project_groups affects 0 rows', not exists (select 1 from public.project_groups where id = '00000000-0000-0000-0000-0000000f0101' and updated_at > now());
-- profile: language yes, e-mail no
update public.profiles set preferred_lang = 'en' where id = auth.uid();
insert into results select 'own preferred_lang update allowed', (select preferred_lang from public.profiles where id = auth.uid()) = 'en';
do $$ begin
  begin
    update public.profiles set email = 'teacher@leap.local' where id = auth.uid();
    insert into results values ('student cannot change own profile e-mail', false);
  exception when others then insert into results values ('student cannot change own profile e-mail', true); end;
end $$;
reset role;

-- 3. teacher of course A sees all three docs; a 'docent' of another course sees none
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'course teacher sees all docs', count(*) = 3 from public.project_documents;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d001', 'outsider@leap.local');
insert into results select 'docent of another course sees no docs', count(*) = 0 from public.project_documents;
reset role;

-- 4. profile insert must use the own login address
delete from public.profiles where id = '00000000-0000-0000-0000-00000000c002';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c002', 'student2@leap.local');
do $$ begin
  begin
    insert into public.profiles (id, email, role, full_name) values (auth.uid(), 'admin@leap.local', 'student', 'x');
    insert into results values ('profile insert with someone else''s e-mail refused', false);
  exception when others then insert into results values ('profile insert with someone else''s e-mail refused', true); end;
end $$;
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
