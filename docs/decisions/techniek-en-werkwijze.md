# Techniek en werkwijze

Besluiten en werking van LEAP op dit gebied, zoals ze in de oude CLAUDE.md stonden. Geen instructies die altijd gelden, maar naslag: lees dit als je aan dit onderdeel werkt, en werk het bij als een besluit verandert.

## Server code

### Where code goes
- `server/index.js` only boots and wires: environment, clients, global middleware (in a fixed order), one `registerXRoutes(app)` / `installX(app, …)` call per domain, static files, listen. Do not add routes or helpers to it.
- Routes live in `server/<domain>/routes.js` (or a named `*Routes.js` in that folder) and export `registerXRoutes(app)` or `registerXRoutes(app, deps)`. Feature modules in the same folder hold the logic; shared plumbing lives in `server/lib/` (auth, Supabase clients, Azure OpenAI, uploads, HTTP security, turn signing), translations in `server/i18n/`.
- New work goes into the matching domain folder (or a new one). Express runs middleware and routes in registration order, so a new `register…` call goes where its routes must sit relative to the others.
- When a file you touch is very large, offer to move the part you work on into its own module first, as a separate commit with no behaviour change, instead of growing the file.
- A route module never imports `server/index.js`.

### Source-guard tests
- Tests that check the server code itself use `server/__tests__/helpers/serverSource.js` (`routeSource("app.post('/api/…',")`, `functionSource(name)`, `routeFile(…)`, `allServerSource()`), which find code wherever it lives and throw when nothing matches. Never `readFileSync` one file and slice between two markers: that silently checks the wrong code after a move.

### Security basics
- Every route authenticates first (`requireAuthUser(req, res)` returns `{ user, profile }` or has already answered with 401/503; `authUser(req)` for project routes) and then authorises against THIS resource: `userHasCourseAccess` / `isStaffForCourse` / `isLeapAdmin` (`server/lib/auth.js`), `isGroupMember` / `userHasProjectAccess` / `requireProjectStaff` (`server/projects/access.js`). Group content: `isLeapAdmin` + membership, never `isStaffForCourse`.
- Never trust an id, role, course or price-like value from the body or query without checking it against the logged-in user.
- `supabaseAdmin` (service role) bypasses RLS: it exists only on the server, and every query with it needs the checks above.
- Rate limits use `req.ip` (`trust proxy` is set to exactly one hop in `server/lib/httpSecurity.js`); never parse `X-Forwarded-For` yourself.
- In new code, answer unexpected errors with status 500 and a generic message (logged on the server with context); do not send `err.message` or stack traces to the browser.
- New user-facing messages go through `server/i18n/serverI18n.js` (see `docs/decisions/techniek-en-werkwijze.md`). New AI routes go into `AI_PATHS` (token budget).

## Database migrations and RLS

For a big change, ask the `security-reviewer` agent to look at the migration.

- A push to `main` applies every new file in `supabase/migrations/` to the production database at start-up (`scripts/migrate.mjs`, tracked in `public.leap_migrations`), exactly once. A failing migration keeps the previous app version running.
- Name migrations `<YYYYMMDDHHMMSS>_<name>.sql` and make each one runnable exactly once. Never edit or rename a migration that is already on `main`; fix it with a new migration.
- Every migration gets a rollback script `supabase/rollback/<same timestamp>_<name>_down.sql`.
- Schema changes only through migration files, never through a dashboard or ad-hoc SQL on the Azure database, so the schema can always be rebuilt from `supabase/migrations/`.
- Test first on the local throw-away database: `npm run db:local`, then `bash scripts/local-db/test.sh`. Add a `scripts/local-db/tests/<name>.sql` check (lines starting with `PASS`/`FAIL`) for new RLS rules. Never point these scripts at the Azure database.
- Every new table gets RLS enabled with explicit policies; a table with a user column must also be listed in `EXPORT_SOURCES` or `NOT_EXPORTED` (`server/account/myData.js`).
- Rules that guard learning data and privacy (`20261008100000_teacher_privacy`, `20261009120000_learning_data_integrity`, `20261015100000_course_features`, `20261030100000_security_hardening`) must keep holding after your migration; see `docs/decisions/privacy-en-data.md`.

## Hosting on Azure

Resource names: `azure/scripts/config.sh` and `azure/README.md`. Ask before running any `az` command that changes something.

- LEAP runs on Azure (resource group `vu-leap-rg`); the setup and runbook live in `azure/` (`azure/README.md`). Supabase stays the API: Auth (GoTrue), PostgREST and Storage are self-hosted there, so keep using the Supabase client, RLS and `supabase/migrations/` as before. Do not replace them with Azure-native services.
- A push to `main` deploys (`.github/workflows/azure-deploy.yml`; active once the repo variable `AZURE_CLIENT_ID` is set; changes to `**.md`, `docs/**`, `azure/**` and `.claude/**` alone do not trigger it). The deploy builds and deploys; the tests run in the separate `Tests` workflow on pull requests (`.github/workflows/test.yml`), so merge only when it is green. New files in `supabase/migrations/` are applied by the app at start-up (`scripts/migrate.mjs`, tracked in `public.leap_migrations`); a failing migration keeps the previous version running. Name migrations `<YYYYMMDDHHMMSS>_<name>.sql` and make each one runnable exactly once .
- Supabase Realtime and Edge Functions do not exist on Azure. Anything that listens for database changes goes through `liveUpdates` (`src/lib/liveUpdates.ts`), which subscribes where Realtime exists and refreshes periodically where it does not. Do not call `supabase.functions.invoke`; add an Express route instead. (The Edge Functions in `supabase/functions/` do not run on Azure.)
- E-mail goes through `getEmailConfig()` / `sendEmail()` (`server/lib/notifications.js`): Azure Communication Services on Azure (sender `leap@vu-edulab.nl`, a send-only domain, so replies go to `MAIL_REPLY_TO`), Resend elsewhere. Account e-mails (confirm, invite, password reset) are built in `server/account/authEmailHook.js`, texts under `email.auth.*`. The limit is 30 e-mails per minute and 100 per hour.
- The app runs as exactly one always-on replica: jobs and timers held in process memory (`conceptJobs`, the Studiecafé digest, LTI state/nonce, daily limit counters) must be persisted in the database before scaling out.
- Secrets live in Key Vault (`kv-vu-leap`), never in the repo or in GitHub; the repo is public. Locally they sit in `.env` (git-ignored), filled by `node azure/scripts/local-env.mjs`.

### Sensitive notes
- Do not put secrets in the repo.
- Trust `.env` values only when they are actually loaded and resolved in the runtime environment.
- For Azure calls, use the configured deployment names and API version; do not silently fall back to public OpenAI for embeddings.
- Do not describe unfixed weaknesses of the Azure setup in the repo (public); report them to the maintainer privately.

## Language and translations


- No user-visible text may exist only in Dutch. Every UI string goes through i18n (`t('key')` in components, `tStatic(getActiveLang(), 'key')` elsewhere; `src/i18n/translations.ts`, `src/i18n/activeLang.ts`); `src/i18n/locales/nl.json` is the source of truth, `src/i18n/locales/en.json` is maintained by hand, and the other languages are filled with `node --env-file=.env scripts/i18n-generate.mjs` (re-run until "RESTEREND totaal: 0"). The locale parity test (`src/__tests__/languageRegistrySync.test.ts`) must pass.
- Server messages shown to users (JSON `error`/`message`/`warning`/`hint`) are translated centrally by the response middleware in `server/i18n/serverI18n.js` using the language the client sends (`X-LEAP-Lang`); add new messages to that dictionary (see the file header: `node scripts/extract-server-messages.mjs`, then `node --env-file=.env scripts/server-i18n-generate.mjs`) instead of hard-coding per-language text. `server/__tests__/serverI18n.test.js` fails when `server/i18n/messages.source.json` is out of date.
- Prompts sent to the language model are not UI text and stay as they are.
- Generic button/status words use `common.*` keys (e.g. `common.cancelAction`, `common.busy`), never a key borrowed from an unrelated feature namespace.
- Content written by people (e.g. system messages, see `docs/decisions/techniek-en-werkwijze.md`) is translated on display with `useContentTranslation` (`src/hooks/useContentTranslation.ts`).
- Help-text ids and placement: see `docs/decisions/techniek-en-werkwijze.md`.

## UI: look and feel, admin layout and help texts

### Look and feel
- Colours come from the LEAP palette: CSS variables `--leap-brand-*`, `--leap-ink-*`, `--leap-accent-*` in `src/index.css`, wired up in `tailwind.config.js`. Use `brand-*` for the main colour, `ink-*` for neutrals and `accent-*` for successes/rewards. `blue`/`sky` map to brand and `gray`/`slate` to ink, so existing classes follow the palette. Never hard-code hex colours in components.
- Font: Nunito, self-hosted via `@fontsource-variable/nunito` (no Google Fonts link). Formulas are rendered by KaTeX in its own fonts.

### Help texts and hints
- Help texts in the admin ("?" buttons, `src/components/help/HelpTip.tsx`) belong to a FUNCTION, not a place: ids live in `src/help/helpTopics.ts`, texts under `help.<id>.title/body`. When restructuring the admin, move the `<HelpTip>` with its control, update the text if the behaviour changed, and remove the id when a function disappears. `src/help/__tests__/helpTopics.test.ts` fails on unknown, unused or stray help ids.
- Student pages use the same `<HelpTip>` with `always` (stays visible even when a teacher switched "Uitleg tonen" off in that browser), ids under `student.*` (2026-10-20). Only for controls whose effect is not obvious; each text says what happens, what is stored and who sees it (e.g. "je docent ziet het niet"). The Ontwerphulp reads these too (`OTHER_PAGES`, group `student`; see `docs/decisions/leren-met-ai.md`).
- Icon-only buttons get `<Tooltip label={t(…)}>` (`src/components/help/Tooltip.tsx`: hover + keyboard focus, sets aria-label) instead of `title=`. Explanation text in the admin uses `<AdminHint variant="intro|tip|warning">` (`src/components/help/AdminHint.tsx`) instead of ad-hoc grey lines or blue boxes; `tip` and all HelpTips disappear when the teacher switches "Uitleg tonen" off (`HelpToggle`, `src/components/help/helpVisibility.ts`).
- All texts go through i18n (see the i18n section above).

### Admin layout
- The Beheer menu follows the order of setting up a course (2026-10-26, `tabGroups` in `src/pages/AdminPage.tsx`, same order in `ADMIN_SECTIONS`): Inhoud (Cursusmateriaal, Projecten), AI-tutor (Tutor-instructies, Zoekgevoeligheid AI), Quiz (Bronnen van quizvragen, Vraagbanken importeren), Openstellen (Onderdelen aan/uit, Deelnemers toevoegen), Volgen (Analytics); Systeem for admins. Keep new tabs in this logic.
- List rows in the admin (title + badges + buttons) use `ListRow` / `RowActions` (`src/components/ui/`): buttons that do not fit go into "⋯ More", dangerous actions always sit there, separated and in red. Never build a `flex justify-between` row with a button group that is not allowed to shrink.
- A `<HelpTip>` and the control it explains form ONE non-wrapping block (`<span className="flex flex-nowrap items-center gap-1">control + HelpTip</span>`) inside a row that may wrap, so the question mark never ends up on another line than its button.
- Flex children that hold text get `min-w-0`; buttons get `whitespace-nowrap` inside a row that may wrap (`flex-wrap`). Grids inside the admin choose columns by the available space (`grid-cols-[repeat(auto-fill,minmax(min(Xrem,100%),1fr))]`), not by the screen width: the admin content column is much narrower than the screen.
- Admin modals that can grow taller than the screen are rendered with `createPortal(…, document.body)`. The sticky top bar is z-50, and a modal inside the page content would fall behind it.
- Check layout with `npm run ui:audit` (Edge via playwright-core; test account via `node --env-file=.env scripts/ui-audit-account.mjs create`). It opens every page and admin tab at 390/1024/1366 px and reports squeezed text, overlap, content sticking out of its card and horizontal scrolling. The report goes to `ui-audit-output/` (git-ignored).

## Background tasks

- Admin actions that take longer than a few seconds run as a background task via `startTask` (`src/lib/backgroundTasks.ts`), not only inside the component. Examples: extracting concepts, uploading files, importing or updating websites, and ShareStats imports.
- A task keeps running when the user moves to another part of the app. The task tray (`TaskTray`, `src/components/TaskTray.tsx`, bottom right) shows progress and a "… is done — View result" notice with a link back.
- Work that runs on the server gets `where: 'server'` and a resumer, so it also survives a page reload. Work the browser does itself gets `where: 'browser'`, and the app warns before the tab is closed.
- Report progress as `{ done, total, labelKey }`. Components read a task that is still running through `useTask(kind, key)`, so they show its progress again when the user comes back.
- Server-side job state lives in process memory (e.g. `conceptJobs`); see `docs/decisions/techniek-en-werkwijze.md` (single replica).

## System messages (2026-10-16)

- The admin sends one-way messages (Beheer → Berichten, admin only) to all users, all students (profile role student), all teachers (profile role docent), or one course (students only, or everyone in it). Optional start and end time; kind info or warning. Code: `server/system/systemMessages.js` (one `registerSystemMessageRoutes` call in `server/system/routes.js`), migration `20261016120000_system_messages` (+ rollback).
- Messages show at the top of the Dashboard until dismissed; while one is open, "Dashboard" in the menu shows a red exclamation mark (not on the Dashboard itself). One shared store, `src/lib/systemMessages.ts`, polls every 2 minutes and on tab focus (no Realtime on Azure). Text is translated on display (`useContentTranslation`), not in the admin preview.
- Privacy: only the fact that a user dismissed a message is stored (`system_message_dismissals`, in My data export); the admin sees totals only (recipients, dismissed), never names.
