---
paths:
  - "supabase/**"
  - "scripts/migrate.mjs"
  - "scripts/local-db/**"
  - "azure/db/**"
---

# Database migrations and RLS

Step-by-step procedure: the `new-migration` skill. Security checklist for RLS and functions: the `secure-change` skill.

- A push to `main` applies every new file in `supabase/migrations/` to the production database at start-up (`scripts/migrate.mjs`, tracked in `public.leap_migrations`), exactly once. A failing migration keeps the previous app version running.
- Name migrations `<YYYYMMDDHHMMSS>_<name>.sql` and make each one runnable exactly once. Never edit or rename a migration that is already on `main`; fix it with a new migration.
- Every migration gets a rollback script `supabase/rollback/<same timestamp>_<name>_down.sql`.
- Schema changes only through migration files, never through a dashboard or ad-hoc SQL on the Azure database, so the schema can always be rebuilt from `supabase/migrations/`.
- Test first on the local throw-away database: `npm run db:local`, then `bash scripts/local-db/test.sh`. Add a `scripts/local-db/tests/<name>.sql` check (lines starting with `PASS`/`FAIL`) for new RLS rules. Never point these scripts at the Azure database.
- Every new table gets RLS enabled with explicit policies; a table with a user column must also be listed in `EXPORT_SOURCES` or `NOT_EXPORTED` (`server/account/myData.js`).
- Rules that guard learning data and privacy (`20261008100000_teacher_privacy`, `20261009120000_learning_data_integrity`, `20261015100000_course_features`, `20261030100000_security_hardening`) must keep holding after your migration; see `privacy-and-integrity.md`.
