---
name: secure-change
description: Security checklist for LEAP changes that touch login or roles, API routes, course or group access, RLS policies or migrations, file uploads and document handling, Canvas/LTI, outgoing HTTP requests, LLM prompts that contain student or teacher data, or secrets and configuration. Use it while designing such a change and again before committing it.
---

# Secure change checklist (LEAP)

Use this while you write the change, then walk through it once more on the final diff. Skip sections that clearly do not apply, but say which ones you skipped. Report the result to the user in plain Dutch: what you checked, what you changed because of it, and what still needs a human decision.

The repo is public. Write nothing about an unfixed weakness in code comments, commit messages, PRs, issues or docs. Report it to the user in the conversation only.

## 1. Who may do this? (authentication and authorisation)
- [ ] The route authenticates first: `requireAuthUser(req, res)` (returns `{ user, profile }` or has already answered), or `authUser(req)` in project routes. No route without it unless it is deliberately public (login, LTI launch, health); then say why in a comment.
- [ ] It then authorises against the specific resource in the request, not just "is logged in" or a global role: course → `userHasCourseAccess` / `isStaffForCourse`; LEAP admin → `isLeapAdmin`; project → `userHasProjectAccess` / `requireProjectStaff`; group content → `isGroupMember` + `isLeapAdmin` (never `isStaffForCourse`). Helpers: `server/lib/auth.js`, `server/projects/access.js`.
- [ ] Every id in params, body or query (course, group, document, user, conversation) is checked against the logged-in user before use (object-level authorisation, OWASP API1). A `user_id` for "myself" comes from the token, not from the body.
- [ ] The response returns only fields this user may see (property-level authorisation, API3). No invite codes, e-mail addresses, rubric text or other students' data by accident; check `select('*')`.
- [ ] Admin-only and teacher-only actions are checked on the server, not only hidden in the UI (function-level authorisation, API5).
- [ ] The teacher privacy model still holds (`.claude/rules/privacy-and-integrity.md`); `server/__tests__/teacherPrivacy.test.js` passes.
- [ ] Role changes, course-teacher promotion and account linking (invitations, Canvas) go through the existing server paths (`promoteCourseTeacherProfile`, `processLaunch`), never through a new shortcut.

## 2. Input, output and errors
- [ ] Input is validated at the boundary: type, length, allowed values, array sizes. Unknown fields are ignored, not stored.
- [ ] SQL is parameterised (`pgPool.query(text, values)` or PostgREST filters). No SQL built from strings. `LIKE`/`ILIKE` input is escaped (`likeExact` in `server/lti/lti.js` shows how).
- [ ] Nothing from a user, a document or the model is rendered as raw HTML. No new `dangerouslySetInnerHTML` without a sanitiser; KaTeX stays `trust: false`.
- [ ] Unexpected errors: log them on the server with context, answer with status 500 and a generic message. Do not send `err.message`, stack traces or SQL errors to the browser in new code.
- [ ] Logs contain no tokens, passwords, attachment content, full prompts with student text or other personal data beyond an id.

## 3. Database, RLS and migrations
- [ ] Every new table has RLS enabled and explicit policies for each operation it needs; no policy means no access, which is the safe default.
- [ ] Policies check the row against `auth.uid()` and course or group membership, not a global role. If the browser must not write a table, it gets no insert/update/delete policy and the server writes it.
- [ ] `SECURITY DEFINER` functions set `search_path`, check the caller themselves, and are not executable by `anon`/`public` unless that is intended (`REVOKE EXECUTE … FROM public, anon`).
- [ ] Triggers that guard data (`pr_guard_profile_role`, `quiz_attempt_rescore`, the security-hardening rules) still apply after the change.
- [ ] A table with a user column is listed in `EXPORT_SOURCES` or `NOT_EXPORTED` (`server/account/myData.js`).
- [ ] The migration has a rollback and was tested on the local database: `npm run db:local`, a `scripts/local-db/tests/<name>.sql` check that acts as student, teacher, outsider and anon (`as-user.sql`, `as-anon.sql`), then `bash scripts/local-db/test.sh`. See the `new-migration` skill.
- [ ] `supabaseAdmin` (service role, bypasses RLS) is used only in server code, and every query with it is preceded by the checks in section 1.

## 4. Uploads, documents and web import
- [ ] Size, type and page-count limits apply before parsing (multer limits, `server/lib/uploads.js`). The file type is checked on content or extension allowlist, not on the name the browser sent.
- [ ] Storage paths are built from server-side ids, never from a user-provided file name.
- [ ] Downloads and viewers check course membership or group membership of the document, not only a global role.
- [ ] Parsed text is data: office/PDF parsing never executes macros or scripts; text goes into chunks as plain text.

## 5. Outgoing requests (SSRF, API7 and API10)
- [ ] A URL that comes from a user (web import, avatars, Canvas endpoints) is limited to `https:` and checked so it cannot reach internal addresses (localhost, 10.x, 169.254.x, 172.16–31.x, 192.168.x, `*.internal`), also after redirects.
- [ ] Responses from other services (Canvas, web pages, Azure OpenAI) are validated before use; timeouts and size limits are set.

## 6. LLM prompts with user data
- [ ] Student, teacher and document text goes into the prompt as clearly marked data; the system prompt is built on the server. The browser sends only conversation turns, never a system prompt, model, role or unlimited `max_tokens`.
- [ ] Instructions inside documents, uploads or student answers are ignored as instructions (see `verifyQuotes` and the `attention` field in `server/projects/preassessment.js`).
- [ ] Model output is never used as a URL, file path, SQL or code; it is rendered as text/Markdown.
- [ ] Only the data the task needs goes to the model (data minimisation). Nothing from another course or another student's private data.
- [ ] A new AI route is listed in `AI_PATHS` (`server/account/tokenBudget.js`) and has a sensible rate or daily limit.

## 7. Canvas / LTI and login flows
- [ ] Signed messages are verified (issuer, audience, expiry, nonce, deployment), state and nonce are single use.
- [ ] Roles come from the course context only; a teacher is never downgraded; account linking by e-mail only to an account with that confirmed e-mail.
- [ ] Any change here gets the `security-reviewer` agent and a human second look before merging.

## 8. Secrets and configuration (fail closed)
- [ ] No secret in code, tests, fixtures, docs, logs or chat output. New secrets go to Key Vault `kv-vu-leap` and are read from `process.env`.
- [ ] A missing or empty secret makes the feature refuse (fail closed), never fall back to a default key, an open CORS rule, a disabled check or public OpenAI. Defaults are safe defaults (Trail of Bits "insecure defaults").
- [ ] CORS, `trust proxy` and security headers stay in `server/lib/httpSecurity.js`; do not loosen them per route.

## 9. Dependencies and workflow
- [ ] No new npm package without asking the user. Check that it exists, is maintained and is the package you think it is (typo-squatting). Run `npm audit --omit=dev` after dependency changes.
- [ ] Changes to `.github/workflows/`, `Dockerfile`, `.claude/` or `CLAUDE.md` are pointed out to the user explicitly.
- [ ] Tests were not weakened or deleted to make the change pass.

## 10. Before merging
- [ ] Relevant tests pass (`npx vitest run server` at least; `server/__tests__/teacherPrivacy.test.js`, `securityHardening.test.js`, `httpSecurity.test.js` when related).
- [ ] Run the `security-reviewer` agent on the diff, or `/security-review` on the branch.
- [ ] Tell the user: "dit is een beveiligingskeuze", with the trade-offs, and suggest a second look by a technical colleague before it reaches `main`.

## Sources
Written for LEAP in our own words, based on:
- OWASP Application Security Verification Standard 5.0 (chapters V1 Encoding and Sanitization, V2 Validation and Business Logic, V4 API and Web Service, V5 File Handling, V8 Authorization, V10 OAuth and OIDC, V13 Configuration, V14 Data Protection, V16 Security Logging and Error Handling): https://owasp.org/www-project-application-security-verification-standard/ (CC BY-SA 4.0)
- OWASP API Security Top 10 (2023): https://owasp.org/API-Security/ (CC BY-SA 4.0)
- OWASP Cheat Sheet Series (Authorization, Node.js Security, File Upload, SSRF Prevention, LLM Prompt Injection Prevention): https://cheatsheetseries.owasp.org/ (CC BY-SA 4.0)
- Trail of Bits skills, "insecure-defaults" and "differential-review" ideas: https://github.com/trailofbits/skills (CC BY-SA 4.0)
- Anthropic `claude-code-security-review` categories: https://github.com/anthropics/claude-code-security-review (MIT)
- Supabase, Row Level Security guide: https://supabase.com/docs/guides/database/postgres/row-level-security (Supabase docs; repository licensed Apache-2.0)
- 1EdTech Security Framework (LTI 1.3): https://www.imsglobal.org/spec/security/v1p0/
No text from these sources is copied verbatim; the checklist is an original adaptation.
