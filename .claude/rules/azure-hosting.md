---
paths:
  - "azure/**"
  - "Dockerfile"
  - ".github/workflows/**"
  - "scripts/migrate.mjs"
  - "server/index.js"
  - "server/lib/{notifications,supabase,azureOpenai,serverUrls,httpSecurity}.js"
  - "server/account/authEmailHook.js"
  - "src/lib/liveUpdates.ts"
  - "supabase/functions/**"
---

# Hosting on Azure

For questions about Azure resources, use the `azure-advisor` agent (read-only). Resource names: `azure/scripts/config.sh` and `azure/README.md`.

- LEAP runs on Azure (resource group `vu-leap-rg`); the setup and runbook live in `azure/` (`azure/README.md`). Supabase stays the API: Auth (GoTrue), PostgREST and Storage are self-hosted there, so keep using the Supabase client, RLS and `supabase/migrations/` as before. Do not replace them with Azure-native services.
- A push to `main` deploys (`.github/workflows/azure-deploy.yml`; active once the repo variable `AZURE_CLIENT_ID` is set; changes to `**.md`, `docs/**` and `azure/**` alone do not trigger it). The workflow builds and deploys; it does not run the tests, so run them before merging. New files in `supabase/migrations/` are applied by the app at start-up (`scripts/migrate.mjs`, tracked in `public.leap_migrations`); a failing migration keeps the previous version running. Name migrations `<YYYYMMDDHHMMSS>_<name>.sql` and make each one runnable exactly once (procedure: `new-migration` skill).
- Supabase Realtime and Edge Functions do not exist on Azure. Anything that listens for database changes goes through `liveUpdates` (`src/lib/liveUpdates.ts`), which subscribes where Realtime exists and refreshes periodically where it does not. Do not call `supabase.functions.invoke`; add an Express route instead. (The Edge Functions in `supabase/functions/` do not run on Azure.)
- E-mail goes through `getEmailConfig()` / `sendEmail()` (`server/lib/notifications.js`): Azure Communication Services on Azure (sender `leap@vu-edulab.nl`, a send-only domain, so replies go to `MAIL_REPLY_TO`), Resend elsewhere. Account e-mails (confirm, invite, password reset) are built in `server/account/authEmailHook.js`, texts under `email.auth.*`. The limit is 30 e-mails per minute and 100 per hour.
- The app runs as exactly one always-on replica: jobs and timers held in process memory (`conceptJobs`, the Studiecafé digest, LTI state/nonce, daily limit counters) must be persisted in the database before scaling out.
- Secrets live in Key Vault (`kv-vu-leap`), never in the repo or in GitHub; the repo is public. Locally they sit in `.env` (git-ignored), filled by `node azure/scripts/local-env.mjs`.

## Sensitive notes
- Do not put secrets in the repo.
- Trust `.env` values only when they are actually loaded and resolved in the runtime environment.
- For Azure calls, use the configured deployment names and API version; do not silently fall back to public OpenAI for embeddings.
- Do not describe unfixed weaknesses of the Azure setup in the repo (public); report them to the maintainer privately.
