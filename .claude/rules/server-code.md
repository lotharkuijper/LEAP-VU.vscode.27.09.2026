---
paths:
  - "server/**/*.js"
---

# Server code

## Where code goes
- `server/index.js` only boots and wires: environment, clients, global middleware (in a fixed order), one `registerXRoutes(app)` / `installX(app, …)` call per domain, static files, listen. Do not add routes or helpers to it.
- Routes live in `server/<domain>/routes.js` (or a named `*Routes.js` in that folder) and export `registerXRoutes(app)` or `registerXRoutes(app, deps)`. Feature modules in the same folder hold the logic; shared plumbing lives in `server/lib/` (auth, Supabase clients, Azure OpenAI, uploads, HTTP security, turn signing), translations in `server/i18n/`.
- New work goes into the matching domain folder (or a new one). Express runs middleware and routes in registration order, so a new `register…` call goes where its routes must sit relative to the others.
- When a file you touch is very large, offer to move the part you work on into its own module first, as a separate commit with no behaviour change, instead of growing the file.
- A route module never imports `server/index.js`.

## Source-guard tests
- Tests that check the server code itself use `server/__tests__/helpers/serverSource.js` (`routeSource("app.post('/api/…',")`, `functionSource(name)`, `routeFile(…)`, `allServerSource()`), which find code wherever it lives and throw when nothing matches. Never `readFileSync` one file and slice between two markers: that silently checks the wrong code after a move.

## Security basics (full checklist: `secure-change` skill)
- Every route authenticates first (`requireAuthUser(req, res)` returns `{ user, profile }` or has already answered with 401/503; `authUser(req)` for project routes) and then authorises against THIS resource: `userHasCourseAccess` / `isStaffForCourse` / `isLeapAdmin` (`server/lib/auth.js`), `isGroupMember` / `userHasProjectAccess` / `requireProjectStaff` (`server/projects/access.js`). Group content: `isLeapAdmin` + membership, never `isStaffForCourse`.
- Never trust an id, role, course or price-like value from the body or query without checking it against the logged-in user.
- `supabaseAdmin` (service role) bypasses RLS: it exists only on the server, and every query with it needs the checks above.
- Rate limits use `req.ip` (`trust proxy` is set to exactly one hop in `server/lib/httpSecurity.js`); never parse `X-Forwarded-For` yourself.
- In new code, answer unexpected errors with status 500 and a generic message (logged on the server with context); do not send `err.message` or stack traces to the browser.
- New user-facing messages go through `server/i18n/serverI18n.js` (see `i18n.md`). New AI routes go into `AI_PATHS` (token budget).
