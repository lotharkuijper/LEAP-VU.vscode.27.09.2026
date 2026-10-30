# Privacy, leerdata en analytics

Besluiten en werking van LEAP op dit gebied, zoals ze in de oude CLAUDE.md stonden. Geen instructies die altijd gelden, maar naslag: lees dit als je aan dit onderdeel werkt, en werk het bij als een besluit verandert.

## Privacy, learning-data integrity and own data

Why: students who know the teacher reads along ask different questions. Privacy is a condition for learning, and a medal must mean what it seems to mean.

### Privacy: what teachers may see (decided 2026-10-08)
- A teacher may ONLY see:
  - who is in their own course(s);
  - who is in which project group within those courses (`/api/projects/:id/groups-overview`; names only).
- No teacher access to:
  - learning journals;
  - quiz attempts, scores and answers;
  - "Ik leg uit" explanations;
  - project sessions;
  - group chats and persona conversations;
  - feedback, badges and relationship (verstandhouding);
  - files uploaded by groups;
  - profiles outside their own courses;
  - the individual learning level of a student (only the distribution).
- The exceptions are things a student deliberately shares: Studiecafé posts and submitted project products.
- Group content is for group members and LEAP admins only. In the server use `isLeapAdmin(profile)` plus membership (`server/lib/auth.js`, `isGroupMember` in `server/projects/access.js`), never `isStaffForCourse` for group content. In the database: migration `20261008100000_teacher_privacy` (rollback in `supabase/rollback/`).
- `server/__tests__/teacherPrivacy.test.js` guards this.
- Roles can only be changed by an admin or the server (trigger `pr_guard_profile_role`). The e-mail address in `profiles` can only be changed by an admin or the server (migration `20261030100000_security_hardening`).
- Analytics are aggregates only (k ≥ 5); see `docs/decisions/privacy-en-data.md`.

### Learning data integrity (2026-10-09)
- The browser writes quiz attempts, journal entries and learning levels directly, so the database guards them (migration `20261009120000_learning_data_integrity`, with rollback):
  - The course must be usable by the user (`leap_can_use_course`).
  - Quiz scores are recomputed by the trigger `quiz_attempt_rescore`: multiple choice against the answer key, open answers clamped to 0–100.
  - Attempts cannot be updated afterwards; students may delete their own.
  - Students cannot update journal entries. Never add a browser-side `.update()` on these tables; `server/__tests__/learningIntegrity.test.js` checks this.
- "Ready for a higher level?" only counts tutor turns the server signed (`turnSignature` / `countVerifiedPriorStudentMessages` in `server/chat/readiness.js`; HMAC in `server/lib/turnSigning.js` with `LEAP_TURN_SECRET` or a key derived from the service-role key). The client keeps the signature on the assistant message (`sig`, stored in `retrieved_context.turnSig`). It is stripped before messages go to the model.
- Teacher analytics average per student first (`perStudentAverage`, `server/analytics/aggregate.js`), so many attempts by one student cannot dominate.
- Achievements are written only by the server (see `docs/decisions/leren-met-ai.md`).

### Auth and profile cache
- Every `callerClient.auth.getUser()` goes through `userCache.getUser(authHeader, …)`, and every `profiles.select('role, email')` by id goes through `profileCache.get(id, loadProfileRoleEmail)` (instances in `server/lib/auth.js`, cache in `server/lib/authCache.js`).
  - TTL is 30 s and never runs past the token's `exp`.
  - Failures are not cached, and the cache is off in tests.
  - After deleting a user, call `userCache.forgetUser(id)` and `profileCache.invalidate(id)`.
  - `server/__tests__/authCache.test.js` fails on a new uncached copy.

### My data (own data)
- My data (`/my-data`, `server/account/myData.js`, routes `/api/me/export` and `/api/me/delete-account`): download everything as JSON, a printable learning record (`src/lib/learningDossier.ts`), and self-service account deletion (confirm with own email; not for admins).
  - New tables with a user column must be listed in `EXPORT_SOURCES` or `NOT_EXPORTED`; `server/__tests__/myData.test.js` checks this.

## Analytics and token budget

### Analytics (tab "Analytics", since 2026-10-09)
- A deliberately LOOSE module, so it can be removed as one piece. Server code lives in `server/analytics/`, frontend in `src/features/analytics/`. The header of `server/analytics/index.js` lists every touchpoint elsewhere: one import and one `installAnalytics(…)` call in `server/index.js`, `purpose: 'tutor_chat'` in `sendChatMessage` (`src/services/llm.service.ts`), the tab in `AdminPage`, `ADMIN_SECTIONS`, the help ids and the locale keys. Do not call analytics code from other modules; `server/__tests__/analytics.test.js` checks that `server/index.js` touches it only through that one import and call, and that no other server module touches it.
- Only aggregates, never people:
  - The table `analytics_counters` holds counters per (week, course, kind, key) with no user ids, no timestamps and no question text. Migration `20261009100000_analytics_counters`, rollback in `supabase/rollback/`.
  - Quiz figures are computed live from `quiz_attempts` and hidden below `K_MIN` = 5 distinct students (per concept, per course and per week) (`server/analytics/aggregate.js`).
  - Teacher analytics average per student first (`perStudentAverage`), so many attempts by one student cannot dominate.
- Measuring happens in one middleware (requests, duration, 5xx errors) and a wrapper around global `fetch` (Azure OpenAI `usage` tokens, attributed to the running request via AsyncLocalStorage). Tutor-chat questions are matched against concept names and aliases in memory, and only the concept name is counted. Measuring must never break a request: every hook is wrapped in try/catch, and a missing table pauses writing.
- Teachers see the concept thermometer for their own course (`isStaffForCourse`). Platform health and costs are for LEAP admins only.
- The tab also shows the learning-level distribution (`LearningLevelsAdminTab`, since 2026-10-26). It is rendered by `AdminPage` next to the module, not inside it, so it stays when the module is removed. Cursus-info (Dashboard block: text, banner, downloads) is no admin tab: it opens per course from Cursussen beheren (`CourseInfoDialog`); old `?tab=course_info` / `?tab=learning_levels` links are redirected.

### Token budget for open registration (2026-10-28)
- Only accounts that came in through open registration (`open_accounts`, marked by `onOpenRegistration` → `markOpenAccount` after signUp; backfill in the migration) have a budget. VU, Canvas and invited accounts are never limited. Code: `server/account/tokenBudget.js` (one `installTokenBudget` call in `server/index.js`, after analytics), migration `20261028100000_token_budget` (+ rollback).
- Estimate: one hour of intensive work ≈ 180,000 tokens (`TOKENS_PER_HOUR`). Default weekly budget = 14 hours (2,520,000), daily limit a third of it (840,000); emergency brake for all open accounts together 100M/week, with an admin mail at 80% and 100%; mail when ≥20 open registrations arrive within an hour. Admin changes these in Beheer → Instellingen (`TokenBudgetPanel`, `__token_budget__` in chatbot_prompts, logged in `leap_setting_changes`); the admin sees totals only, never per person.
- Measured with its own fetch wrapper (Azure OpenAI `usage`, attributed via its own AsyncLocalStorage; analytics stays a separate module) into `token_usage` (per user per Amsterdam day, via `leap_add_token_usage`). Only the AI routes in `AI_PATHS` are blocked (429 `code: 'tokenBudget'`); closing, saving and submitting work is never blocked but is counted. Never block on doubt or a missing table.
- Students see their use in percentages (`TokenBudgetBadge` in the chat toolbar and on the Dashboard, `GET /api/me/token-budget`). Disposable e-mail domains are refused at open registration (`isDisposableEmail`, `server/courses/enrollment.js`), max 10 registrations per IP per hour.
- Tests: `server/__tests__/tokenBudget.test.js`.
- A new AI route must be added to `AI_PATHS`, or open accounts can use it without a budget.
