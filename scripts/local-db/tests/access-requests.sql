-- RLS checks for 20261122100000_access_requests.sql. Access requests from staff go
-- through the server only: users cannot read or write them directly (not even their
-- own; the server shows a user their own requests), and teachers see nothing.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.access_requests (id, user_id, message) values
  ('00000000-0000-0000-0000-0000000ac001', '00000000-0000-0000-0000-00000000c001', 'Graag toegang');

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

select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'user cannot read requests directly', pg_temp.denied('select * from public.access_requests');
insert into results select 'user cannot close a request directly', pg_temp.denied($q$update public.access_requests set status = 'closed'$q$);
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher cannot read requests', pg_temp.denied('select * from public.access_requests');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
