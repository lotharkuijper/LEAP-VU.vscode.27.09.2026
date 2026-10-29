-- Act as a not-logged-in API caller for the rest of the current transaction.
--   begin; \i as-anon.sql  select ...; rollback;
select set_config('request.jwt.claims', '{"role":"anon"}', true) \gset
select set_config('role', 'anon', true) \gset
select current_user as db_role, auth.uid() as uid, auth.role() as jwt_role;
