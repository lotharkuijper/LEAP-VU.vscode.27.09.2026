-- RLS checks for supabase/migrations/20261111200000_project_personas_select_talkers.sql.
-- In an open project a group member reads the talking personas from the
-- database, but not the evaluators; the course teacher reads all of them.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.projects (id, title, research_question, course_id, status) values
  ('00000000-0000-0000-0000-0000000f0e01', 'Open project', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'active');
insert into public.project_groups (id, project_id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000f0e11', '00000000-0000-0000-0000-0000000f0e01', 'Studenten', 'EVL001', '00000000-0000-0000-0000-00000000b001');
insert into public.project_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000f0e11', '00000000-0000-0000-0000-00000000c001');
insert into public.project_personas (project_id, name, persona_type, system_prompt) values
  ('00000000-0000-0000-0000-0000000f0e01', 'Wethouder', 'roleplayer', 'rol'),
  ('00000000-0000-0000-0000-0000000f0e01', 'Begeleider', null, 'begeleiden'),
  ('00000000-0000-0000-0000-0000000f0e01', 'Beoordelaar', 'evaluator', 'beoordeel zo');

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1. student1, member of a group: talking personas yes, evaluator no
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student reads the role player', exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01' and name = 'Wethouder');
insert into results select 'student reads a persona without a type (guide)', exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01' and name = 'Begeleider');
insert into results select 'student does not read the evaluator', not exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01' and persona_type = 'evaluator');
reset role;

-- 2. the course teacher reads all three
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher reads all personas incl. the evaluator', (select count(*) from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01') = 3;
reset role;

-- 3. student2, not in a group of this project: nothing
select pg_temp.as_user('00000000-0000-0000-0000-00000000c002', 'student2@leap.local');
insert into results select 'non-member reads no personas', not exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
