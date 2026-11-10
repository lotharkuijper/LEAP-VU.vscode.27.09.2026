-- RLS checks for supabase/migrations/20261111100000_project_draft.sql.
-- A draft project: student1 is already placed in a group (by the teacher or
-- Canvas) but sees nothing of the project until the teacher opens it; the
-- teacher works in an own test group. Runs as postgres on the seed.sql fixture,
-- all in one rolled-back transaction (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.projects (id, title, research_question, course_id, status) values
  ('00000000-0000-0000-0000-0000000f0d01', 'Concept', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'draft');
insert into public.project_groups (id, project_id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000f0d11', '00000000-0000-0000-0000-0000000f0d01', 'Studenten', 'DRF001', '00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-0000000f0d12', '00000000-0000-0000-0000-0000000f0d01', 'Testgroep', 'DRF002', '00000000-0000-0000-0000-00000000b001');
insert into public.project_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000f0d11', '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-0000000f0d12', '00000000-0000-0000-0000-00000000b001');
insert into public.project_documents (project_id, filename, is_visible_to_students, material_kind) values
  ('00000000-0000-0000-0000-0000000f0d01', 'opdracht.pdf', true, 'assignment');
insert into public.project_personas (project_id, name) values
  ('00000000-0000-0000-0000-0000000f0d01', 'Wethouder');
insert into public.group_chat_messages (group_id, user_id, body) values
  ('00000000-0000-0000-0000-0000000f0d11', '00000000-0000-0000-0000-00000000c001', 'hoi');

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1. student1, placed in a group of the draft: sees nothing
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student does not see the draft project', not exists (select 1 from public.projects where id = '00000000-0000-0000-0000-0000000f0d01');
insert into results select 'student does not see draft personas', not exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0d01');
insert into results select 'student does not see draft documents', not exists (select 1 from public.project_documents where project_id = '00000000-0000-0000-0000-0000000f0d01');
insert into results select 'student does not read the draft group chat', not exists (select 1 from public.group_chat_messages where group_id = '00000000-0000-0000-0000-0000000f0d11');
do $$ begin
  begin
    insert into public.group_chat_messages (group_id, user_id, body) values ('00000000-0000-0000-0000-0000000f0d11', auth.uid(), 'x');
    insert into results values ('student cannot post in the draft group chat', false);
  exception when others then insert into results values ('student cannot post in the draft group chat', true); end;
end $$;
reset role;

-- 2. the teacher: sees the draft, works in the own test group, not in the students' group
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher sees the draft project', exists (select 1 from public.projects where id = '00000000-0000-0000-0000-0000000f0d01');
insert into results select 'teacher does not read the students'' group chat', not exists (select 1 from public.group_chat_messages where group_id = '00000000-0000-0000-0000-0000000f0d11');
do $$ begin
  begin
    insert into public.group_chat_messages (group_id, user_id, body) values ('00000000-0000-0000-0000-0000000f0d12', auth.uid(), 'test');
    insert into results values ('teacher can post in the own test group', true);
  exception when others then insert into results values ('teacher can post in the own test group', false); end;
end $$;
reset role;

-- 3. opened for students: student1 gets in
update public.projects set status = 'active' where id = '00000000-0000-0000-0000-0000000f0d01';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'after opening: student sees the project', exists (select 1 from public.projects where id = '00000000-0000-0000-0000-0000000f0d01');
insert into results select 'after opening: student reads the group chat', exists (select 1 from public.group_chat_messages where group_id = '00000000-0000-0000-0000-0000000f0d11');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
