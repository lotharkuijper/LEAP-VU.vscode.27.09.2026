-- Act as an API caller for the rest of the CURRENT TRANSACTION, the way PostgREST
-- on Azure does (PGRST_DB_USE_LEGACY_GUCS=false => only request.jwt.claims is set;
-- auth.uid()/auth.role()/auth.email()/auth.jwt() all read it).
--
-- Use inside BEGIN ... ROLLBACK (everything is SET LOCAL, so it resets itself):
--   begin;
--   \set uid 00000000-0000-0000-0000-00000000b001
--   \i as-user.sql
--   select * from course_members;      -- runs under RLS as that user
--   rollback;
--
-- psql variables:
--   uid      (required) the user's id, i.e. auth.users.id / profiles.id
--   email    (optional) put in the claims as "email"
--   jwt_role (optional) default 'authenticated'; may be 'anon' or 'service_role'
\if :{?uid}
\else
  \echo 'as-user.sql: set :uid first, e.g. \\set uid 00000000-0000-0000-0000-00000000b001'
  \quit
\endif
\if :{?jwt_role}
\else
  \set jwt_role authenticated
\endif
\if :{?email}
\else
  \set email ''
\endif
select set_config('request.jwt.claims',
  json_strip_nulls(json_build_object(
    'sub', :'uid', 'role', :'jwt_role', 'aud', 'authenticated',
    'email', nullif(:'email', '')))::text, true) as jwt_claims \gset
select set_config('role', :'jwt_role', true) as "current_role" \gset
-- sanity line so you can see who you are
select current_user as db_role, auth.uid() as uid, auth.role() as jwt_role;
