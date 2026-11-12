-- RLS checks for project_personas (20261111200000, tightened by
-- 20261112100000_project_personas_staff_read.sql). A group member reads no
-- personas directly from the database (the server hands them out without what
-- is for the teacher, such as instructions and conduct rules); pr_persona_label
-- gives a member only the name of a persona and its project. The course
-- teacher reads all of them.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.projects (id, title, research_question, course_id, status) values
  ('00000000-0000-0000-0000-0000000f0e01', 'Open project', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'active'),
  ('00000000-0000-0000-0000-0000000f0e02', 'Concept', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'draft');
insert into public.project_groups (id, project_id, name, invite_code, created_by) values
  ('00000000-0000-0000-0000-0000000f0e11', '00000000-0000-0000-0000-0000000f0e01', 'Studenten', 'EVL001', '00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-0000000f0e12', '00000000-0000-0000-0000-0000000f0e02', 'Concept', 'EVL002', '00000000-0000-0000-0000-00000000b001');
insert into public.project_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000f0e11', '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-0000000f0e12', '00000000-0000-0000-0000-00000000c001');
insert into public.project_personas (id, project_id, name, persona_type, system_prompt) values
  ('00000000-0000-0000-0000-0000000f0e21', '00000000-0000-0000-0000-0000000f0e01', 'Wethouder', 'roleplayer', 'rol'),
  ('00000000-0000-0000-0000-0000000f0e22', '00000000-0000-0000-0000-0000000f0e01', 'Begeleider', null, 'begeleiden'),
  ('00000000-0000-0000-0000-0000000f0e23', '00000000-0000-0000-0000-0000000f0e01', 'Beoordelaar', 'evaluator', 'beoordeel zo'),
  ('00000000-0000-0000-0000-0000000f0e24', '00000000-0000-0000-0000-0000000f0e02', 'Conceptpersona', 'roleplayer', 'rol');

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1. student1, member of a group: no personas directly, only a label
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student reads no personas directly (no instructions, no conduct rules)',
  not exists (select 1 from public.project_personas where project_id in ('00000000-0000-0000-0000-0000000f0e01', '00000000-0000-0000-0000-0000000f0e02'));
insert into results select 'student gets name and project of a persona in his open project',
  exists (select 1 from public.pr_persona_label('00000000-0000-0000-0000-0000000f0e21') where persona_name = 'Wethouder' and project_title = 'Open project');
insert into results select 'student gets no label in a draft project',
  not exists (select 1 from public.pr_persona_label('00000000-0000-0000-0000-0000000f0e24'));
reset role;

-- 2. the course teacher reads all personas incl. the evaluator
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher reads all personas incl. the evaluator', (select count(*) from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01') = 3;
reset role;

-- 3. student2, not in a group of this project: nothing
select pg_temp.as_user('00000000-0000-0000-0000-00000000c002', 'student2@leap.local');
insert into results select 'non-member reads no personas', not exists (select 1 from public.project_personas where project_id = '00000000-0000-0000-0000-0000000f0e01');
insert into results select 'non-member gets no label', not exists (select 1 from public.pr_persona_label('00000000-0000-0000-0000-0000000f0e21'));
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
