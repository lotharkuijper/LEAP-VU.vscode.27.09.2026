---
name: verify-change
description: Pick and run the smallest set of LEAP checks that proves a change works - the matching Vitest files, typecheck and lint, server message and locale checks, local database RLS tests, UI audit, and (only when needed) evals against the real model. Use before saying a change is done or ready to push.
---

# Verify a change

1. List the changed files: `git status --short` and `git diff --stat main...HEAD`.
2. Run the checks below that match those files, smallest first. Stop and fix on the first failure.
3. Report in Dutch: each command, pass/fail, and what was NOT checked (and why).

## Always (when code changed)
- The test files of the touched feature: `npx vitest run server/__tests__/<feature>.test.js` or `npx vitest run src/<path>/__tests__/<name>.test.ts(x)`. Find them with `ls server/__tests__ | grep -i <feature>` or by searching the tests for the function name.
- Server code changed: `npx vitest run server` (includes the source-guard tests for privacy, course switches, auth cache, analytics and journal writes).
- Frontend changed: `npm run typecheck` and `npx vitest run src`.
- `npm run lint` on bigger changes.

## By area
| Changed | Also run |
|---|---|
| Routes, auth, access checks | `npx vitest run server/__tests__/teacherPrivacy.test.js server/__tests__/securityHardening.test.js server/__tests__/httpSecurity.test.js`; then the `secure-change` skill |
| New or changed server message | `node scripts/extract-server-messages.mjs --check`, `npx vitest run server/__tests__/serverI18n.test.js` |
| Locale files or UI text | `npx vitest run src/__tests__/languageRegistrySync.test.ts src/help/__tests__/helpTopics.test.ts` |
| Admin tab or help group | `npx vitest run server/__tests__/designAssistant.test.js` |
| Migration or RLS | `npm run db:local`, then `bash scripts/local-db/test.sh` (see the `new-migration` skill) |
| Ingestion, chunking, concepts | `npx vitest run server/__tests__/ragProcessing.test.js server/__tests__/conceptExtraction.test.js server/__tests__/conceptConsolidation.test.js` |
| Moved server code between files | `npx vitest run server` and compare the route list before and after (e.g. a quick script that imports `server/index.js` with `NODE_ENV=test` and prints `app.router.stack` paths); the list must be identical |
| Layout or admin UI | `npm run ui:audit` (needs a test account: `node --env-file=.env scripts/ui-audit-account.mjs create`) |
| Document viewer | `node --env-file=.env scripts/check-document-viewer.mjs` |

## Against the real model or database (costs money, uses a test account)
Run these only when the change touches what they measure, and tell the user first:
- Learning levels in the chat: `node --env-file=.env scripts/eval-level-language.mjs`
- Leerlijn in the chat: `node --env-file=.env scripts/eval-leerlijn.mjs`
- Chat attachments: `node --env-file=.env scripts/eval-chat-attachments.mjs <dir>`, `scripts/check-chat-attachments.mjs`, `scripts/check-chat-attachments-ui.mjs`
- "Verbeter deze uitleg": `node --env-file=.env scripts/eval-flawed-explanations.mjs [n] [dir]`, `scripts/eval-flawed-feedback.mjs`
- Pre-assessment: `node --env-file=.env scripts/check-preassessment.mjs [--long]`
- Invitations end to end: `node --env-file=.env scripts/check-course-invitations.mjs` (API on :3001)
- Explain scoring scale changed: a live calibration run (excellent ≈100, reasonable ≈85, confused ≈40, wrong ≈30).

## Finally
- `git diff` once more: no debug output, no secrets, no unrelated changes, no unused files left behind.
- A push to `main` deploys to production and runs migrations; the deploy workflow does not run these tests.
