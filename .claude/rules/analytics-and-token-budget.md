---
paths:
  - "server/analytics/**"
  - "src/features/analytics/**"
  - "server/account/tokenBudget.js"
  - "src/components/TokenBudgetBadge.tsx"
  - "src/pages/admin/{TokenBudgetPanel,LearningLevelsAdminTab}.tsx"
  - "src/services/llm.service.ts"
---

# Analytics and token budget

## Analytics (tab "Analytics", since 2026-10-09)
- A deliberately LOOSE module, so it can be removed as one piece. Server code lives in `server/analytics/`, frontend in `src/features/analytics/`. The header of `server/analytics/index.js` lists every touchpoint elsewhere: one import and one `installAnalytics(…)` call in `server/index.js`, `purpose: 'tutor_chat'` in `sendChatMessage` (`src/services/llm.service.ts`), the tab in `AdminPage`, `ADMIN_SECTIONS`, the help ids and the locale keys. Do not call analytics code from other modules; `server/__tests__/analytics.test.js` checks that `server/index.js` touches it only through that one import and call, and that no other server module touches it.
- Only aggregates, never people:
  - The table `analytics_counters` holds counters per (week, course, kind, key) with no user ids, no timestamps and no question text. Migration `20261009100000_analytics_counters`, rollback in `supabase/rollback/`.
  - Quiz figures are computed live from `quiz_attempts` and hidden below `K_MIN` = 5 distinct students (per concept, per course and per week) (`server/analytics/aggregate.js`).
  - Teacher analytics average per student first (`perStudentAverage`), so many attempts by one student cannot dominate.
- Measuring happens in one middleware (requests, duration, 5xx errors) and a wrapper around global `fetch` (Azure OpenAI `usage` tokens, attributed to the running request via AsyncLocalStorage). Tutor-chat questions are matched against concept names and aliases in memory, and only the concept name is counted. Measuring must never break a request: every hook is wrapped in try/catch, and a missing table pauses writing.
- Teachers see the concept thermometer for their own course (`isStaffForCourse`). Platform health and costs are for LEAP admins only.
- The tab also shows the learning-level distribution (`LearningLevelsAdminTab`, since 2026-10-26). It is rendered by `AdminPage` next to the module, not inside it, so it stays when the module is removed. Cursus-info (Dashboard block: text, banner, downloads) is no admin tab: it opens per course from Cursussen beheren (`CourseInfoDialog`); old `?tab=course_info` / `?tab=learning_levels` links are redirected.

## Token budget for open registration (2026-10-28)
- Only accounts that came in through open registration (`open_accounts`, marked by `onOpenRegistration` → `markOpenAccount` after signUp; backfill in the migration) have a budget. VU, Canvas and invited accounts are never limited. Code: `server/account/tokenBudget.js` (one `installTokenBudget` call in `server/index.js`, after analytics), migration `20261028100000_token_budget` (+ rollback).
- Estimate: one hour of intensive work ≈ 180,000 tokens (`TOKENS_PER_HOUR`). Default weekly budget = 14 hours (2,520,000), daily limit a third of it (840,000); emergency brake for all open accounts together 100M/week, with an admin mail at 80% and 100%; mail when ≥20 open registrations arrive within an hour. Admin changes these in Beheer → Instellingen (`TokenBudgetPanel`, `__token_budget__` in chatbot_prompts, logged in `leap_setting_changes`); the admin sees totals only, never per person.
- Measured with its own fetch wrapper (Azure OpenAI `usage`, attributed via its own AsyncLocalStorage; analytics stays a separate module) into `token_usage` (per user per Amsterdam day, via `leap_add_token_usage`). Only the AI routes in `AI_PATHS` are blocked (429 `code: 'tokenBudget'`); closing, saving and submitting work is never blocked but is counted. Never block on doubt or a missing table.
- Students see their use in percentages (`TokenBudgetBadge` in the chat toolbar and on the Dashboard, `GET /api/me/token-budget`). Disposable e-mail domains are refused at open registration (`isDisposableEmail`, `server/courses/enrollment.js`), max 10 registrations per IP per hour.
- Tests: `server/__tests__/tokenBudget.test.js`.
- A new AI route must be added to `AI_PATHS`, or open accounts can use it without a budget.
