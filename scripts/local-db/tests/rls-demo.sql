-- Demonstrates as-user.sql and checks a few real policies on the seed.sql fixture.
-- Run via: bash scripts/local-db/test.sh rls-demo
-- Each block is BEGIN ... ROLLBACK, so nothing stays behind. A failing check
-- raises an exception, which stops psql and makes test.sh fail.
\set ON_ERROR_STOP on
\set QUIET on

-- student1 sees only their own course_members row
begin;
\set uid 00000000-0000-0000-0000-00000000c001
\ir ../as-user.sql
do $$ begin
  if (select count(*) from course_members) <> 1 then raise exception 'student1 should see 1 membership row'; end if;
end $$;
-- a student cannot make themselves teacher (no client writes on course_members)
do $$ begin
  begin
    insert into course_members (course_id, user_id, role, member_role)
      values ('00000000-0000-0000-0000-0000000c0b01', auth.uid(), 'teacher', 'teacher');
    raise exception 'student1 could insert into course_members!';
  exception when insufficient_privilege then null; end;
end $$;
-- a student cannot change their own profile role (pr_guard_profile_role)
do $$ begin
  begin
    update profiles set role = 'admin' where id = auth.uid();
    raise exception 'student1 could promote themselves!';
  exception when raise_exception then
    if sqlerrm like 'student1 could%' then raise; end if;
  end;
end $$;
rollback;

-- the admin sees every membership row
begin;
\set uid 00000000-0000-0000-0000-00000000a001
\ir ../as-user.sql
do $$ begin
  if (select count(*) from course_members) < 3 then raise exception 'admin should see all memberships'; end if;
end $$;
rollback;

-- anon sees nothing
begin;
\ir ../as-anon.sql
do $$ begin
  if (select count(*) from course_members) <> 0 then raise exception 'anon should see no memberships'; end if;
end $$;
rollback;

\echo 'PASS rls-demo: all checks passed'
