-- Checks for 20261123100000_course_is_test.sql. In a test course only admins can be
-- members; a course with members who are not admins cannot become a test course.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
create temp table results(check_name text, ok boolean);

create or replace function pg_temp.refused(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when raise_exception then
  return true;
end $$;

insert into public.courses (id, name, description) values
  ('00000000-0000-0000-0000-0000000c0e01', 'Demo (local)', 'test course');
insert into public.course_members (course_id, user_id, role, member_role) values
  ('00000000-0000-0000-0000-0000000c0e01', '00000000-0000-0000-0000-00000000a001', 'teacher', 'teacher');

insert into results select 'course with only an admin becomes a test course',
  not pg_temp.refused($q$update public.courses set is_test = true where id = '00000000-0000-0000-0000-0000000c0e01'$q$);
insert into results select 'student cannot be added to a test course',
  pg_temp.refused($q$insert into public.course_members (course_id, user_id, role, member_role) values ('00000000-0000-0000-0000-0000000c0e01', '00000000-0000-0000-0000-00000000c001', 'student', 'student')$q$);
insert into results select 'teacher cannot be added to a test course',
  pg_temp.refused($q$insert into public.course_members (course_id, user_id, role, member_role) values ('00000000-0000-0000-0000-0000000c0e01', '00000000-0000-0000-0000-00000000b001', 'teacher', 'teacher')$q$);
insert into results select 'student cannot become an alumnus of a test course',
  pg_temp.refused($q$insert into public.course_alumni (course_id, user_id) values ('00000000-0000-0000-0000-0000000c0e01', '00000000-0000-0000-0000-00000000c001')$q$);

-- A teacher cannot switch is_test on their own course directly (no rows updated).
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000b001', 'role', 'authenticated')::text, true);
set local role authenticated;
update public.courses set is_test = true where id = '00000000-0000-0000-0000-0000000c0a01';
reset role;
insert into results select 'teacher cannot switch a course to test course directly',
  not (select is_test from public.courses where id = '00000000-0000-0000-0000-0000000c0a01');
grant all on results to authenticated;

insert into results select 'course with a student cannot become a test course',
  pg_temp.refused($q$update public.courses set is_test = true where id = '00000000-0000-0000-0000-0000000c0a01'$q$);

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
