---
name: new-migration
description: How to add a database change to LEAP (new table, column, policy, function or trigger) as a Supabase migration with a rollback, tested on the local throw-away database. Use whenever a change needs SQL, before writing any file in supabase/migrations/.
---

# Adding a database migration

Remember: a push to `main` runs every new migration on the production database at start-up (`scripts/migrate.mjs`), exactly once, with real student data. There is no staging database.

## 1. Decide whether you need one
- Schema, RLS policies, functions, triggers and seed rows that the app depends on: yes, a migration.
- One-off data repairs: ask the user first; they may belong in `supabase/maintenance/` and be run by hand instead.
- Never change the schema through a dashboard or ad-hoc SQL on Azure: the schema must always be rebuildable from `supabase/migrations/`.

## 2. Create the files
1. Name: `supabase/migrations/<YYYYMMDDHHMMSS>_<snake_case_name>.sql`, with a timestamp later than the newest file in that folder (`ls supabase/migrations | tail -1`).
2. Rollback: `supabase/rollback/<same timestamp>_<same name>_down.sql`. It undoes the change and ends with `DELETE FROM public.leap_migrations WHERE name = '<migration file name>';` so the migration can be applied again later. See `supabase/rollback/20261028100000_token_budget_down.sql`.
3. Start the migration with a comment block: what it does and why (in Dutch is fine), which code uses it, and the rollback path. No details about unfixed weaknesses (public repo).

## 3. Write it so it runs exactly once, safely
- The file runs as one batch; without your own `BEGIN`/`COMMIT` a failure rolls the whole file back. Do not add your own transaction control, and avoid `CREATE INDEX CONCURRENTLY` (not allowed in a transaction).
- Write defensively anyway, so a manual re-run after a partial failure does no harm: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS …` before `CREATE POLICY …`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, `ON CONFLICT DO NOTHING` for seed rows.
- Never edit, rename or delete a migration that is already on `main` (it has run in production). Fix mistakes with a new migration.
- Keep data-changing statements safe for large tables (no full-table rewrites without asking).

## 4. Security in the same file
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` on every new table, with explicit policies per operation. A table only the server writes gets no browser insert/update/delete policy.
- Policies use `auth.uid()` and course/group membership helpers (`is_course_member`, `leap_can_use_course`, `pr_is_course_staff`), not a global role. Teachers never get read access to student learning data or group content (`.claude/rules/privacy-and-integrity.md`).
- `SECURITY DEFINER` functions: `SET search_path = public`, check the caller inside, and `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated;` unless a role must call it, then `GRANT` exactly that.
- A table with a user column: add it to `EXPORT_SOURCES` or `NOT_EXPORTED` in `server/account/myData.js` (`server/__tests__/myData.test.js` checks this).
- Run through the `secure-change` skill, section 3.

## 5. Test locally
1. `npm run db:local` builds a fresh local database with ALL migrations (also proves the schema can be rebuilt from zero). Needs Docker (OrbStack or Docker Desktop). Never point these scripts at Azure.
2. Add `scripts/local-db/tests/<name>.sql` for new policies: everything inside `begin; … rollback;`, switch users with `\set uid …` + `\ir ../as-user.sql` (or `\ir ../as-anon.sql`), one output line per check starting with `PASS ` or `FAIL `. Test at least: the owner, a student of another course, a teacher of the course (for privacy), an outsider and anon. Test data and ids: `scripts/local-db/README.md`.
3. `bash scripts/local-db/test.sh` (all tests) or `bash scripts/local-db/test.sh <name>`.
4. Test the rollback: `bash scripts/local-db/psql.sh`, run the `_down.sql` file, then run the migration file again.
5. Run the server tests that guard database rules: `npx vitest run server/__tests__/securityHardening.test.js server/__tests__/migrationPlan.test.js` plus the feature's own tests.
6. `bash scripts/local-db/down.sh` when done.

## 6. Hand-off
Tell the user in Dutch: what the migration changes, that it runs automatically on production at the next push to `main`, how to roll it back, and what you tested. Suggest the `security-reviewer` agent when policies or functions changed.
