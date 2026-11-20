-- RLS checks for 20261121100000_image_exercise_attempts.sql. Attempts at an image
-- exercise are student learning data and sit next to the answer key: only the
-- server (service role) reads and writes them. Not the student directly (the server
-- decides what is found), and never the teacher (teachers see no learning data).
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.image_exercises (id, course_id, storage_path, filename, mime_type, description) values
  ('00000000-0000-0000-0000-0000000b1e02', '00000000-0000-0000-0000-0000000c0a01', 'c/f.jpg', 'f.jpg', 'image/jpeg', 'GEHEIM');
insert into public.image_exercise_attempts (id, exercise_id, user_id, course_id, progress, turns) values
  ('00000000-0000-0000-0000-0000000a7701', '00000000-0000-0000-0000-0000000b1e02', '00000000-0000-0000-0000-00000000c001',
   '00000000-0000-0000-0000-0000000c0a01', '{}', '[{"role":"student","text":"PRIVE"}]');

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when insufficient_privilege then
  return true;
end $$;

-- 1. the student cannot read or change attempts directly (the server decides what counts as found)
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student cannot read attempts directly', pg_temp.denied('select * from public.image_exercise_attempts');
insert into results select 'student cannot mark features as found',
  pg_temp.denied($q$update public.image_exercise_attempts set progress = '{"x":{"state":"full"}}'$q$);
reset role;

-- 2. the course teacher never sees what a student did
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher cannot read attempts', pg_temp.denied('select * from public.image_exercise_attempts');
reset role;

-- 3. attempts go with the photo
delete from public.image_exercises where id = '00000000-0000-0000-0000-0000000b1e02';
insert into results select 'attempts go with their photo',
  not exists (select 1 from public.image_exercise_attempts where id = '00000000-0000-0000-0000-0000000a7701');

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
