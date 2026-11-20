-- RLS checks for 20261120100000_image_exercises.sql. The descriptions and features
-- of an image exercise are an answer key: only the server (service role) reads and
-- writes them. Students and teachers get nothing directly, neither from the tables
-- nor from the private storage bucket 'image_exercises'.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.image_exercises (id, course_id, storage_path, filename, mime_type, description) values
  ('00000000-0000-0000-0000-0000000b1e01', '00000000-0000-0000-0000-0000000c0a01', 'c/foto-1.jpg', 'foto-1.jpg', 'image/jpeg', 'GEHEIM: hersenweefsel');
insert into public.image_exercise_features (exercise_id, label, observation) values
  ('00000000-0000-0000-0000-0000000b1e01', 'GEHEIM kenmerk', 'GEHEIM');
insert into storage.objects (bucket_id, name) values ('image_exercises', 'c/foto-1.jpg');

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

-- 1. a student of the course cannot read or write the answer key or the photos
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student cannot read image exercises', pg_temp.denied('select * from public.image_exercises');
insert into results select 'student cannot read image exercise features', pg_temp.denied('select * from public.image_exercise_features');
insert into results select 'student cannot add an image exercise',
  pg_temp.denied($q$insert into public.image_exercises (course_id, storage_path, filename, mime_type) values ('00000000-0000-0000-0000-0000000c0a01', 'x', 'x', 'image/png')$q$);
insert into results select 'student sees no photo in the private bucket',
  not exists (select 1 from storage.objects where bucket_id = 'image_exercises');
reset role;

-- 2. the course teacher cannot reach the tables or the bucket directly either (only via the server)
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher cannot read image exercises directly', pg_temp.denied('select * from public.image_exercises');
insert into results select 'teacher cannot change features directly',
  pg_temp.denied($q$update public.image_exercise_features set label = 'x'$q$);
insert into results select 'teacher sees no photo in the private bucket directly',
  not exists (select 1 from storage.objects where bucket_id = 'image_exercises');
reset role;

-- 3. removing the course removes its exercises and their features
insert into results select 'bucket is private', exists (select 1 from storage.buckets where id = 'image_exercises' and public = false);
delete from public.image_exercises where id = '00000000-0000-0000-0000-0000000b1e01';
insert into results select 'features go with their exercise',
  not exists (select 1 from public.image_exercise_features where exercise_id = '00000000-0000-0000-0000-0000000b1e01');

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
