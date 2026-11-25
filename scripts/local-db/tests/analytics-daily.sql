-- RLS checks for 20261125100000_analytics_daily.sql. Daily counters are server
-- only: no user (student or teacher) can read them or bump them directly.
-- Runs as postgres on the seed.sql fixture, in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
select public.analytics_bump_daily('[{"day":"2026-11-24","course_id":"","kind":"tokens","key":"chat","n":1,"total":100},{"day":"2026-11-24","course_id":"","kind":"tokens","key":"chat","n":1,"total":50}]'::jsonb);

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;
insert into results select 'bumps add up on the same day/kind/key',
  (select n = 2 and total = 150 from public.analytics_daily where day = '2026-11-24' and kind = 'tokens' and key = 'chat');

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

select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student cannot read daily counters', pg_temp.denied('select * from public.analytics_daily');
insert into results select 'student cannot bump daily counters', pg_temp.denied($q$select public.analytics_bump_daily('[]'::jsonb)$q$);
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher cannot read daily counters', pg_temp.denied('select * from public.analytics_daily');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
