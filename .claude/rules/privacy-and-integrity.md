---
paths:
  - "server/**/*.js"
  - "supabase/**"
  - "src/pages/MyDataPage.tsx"
  - "src/lib/learningDossier.ts"
  - "src/pages/admin/**"
  - "src/components/admin/**"
---

# Privacy, learning-data integrity and own data

Why: students who know the teacher reads along ask different questions. Privacy is a condition for learning, and a medal must mean what it seems to mean.

## Privacy: what teachers may see (decided 2026-10-08)
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
- Analytics are aggregates only (k ≥ 5); see `analytics-and-token-budget.md`.

## Learning data integrity (2026-10-09)
- The browser writes quiz attempts, journal entries and learning levels directly, so the database guards them (migration `20261009120000_learning_data_integrity`, with rollback):
  - The course must be usable by the user (`leap_can_use_course`).
  - Quiz scores are recomputed by the trigger `quiz_attempt_rescore`: multiple choice against the answer key, open answers clamped to 0–100.
  - Attempts cannot be updated afterwards; students may delete their own.
  - Students cannot update journal entries. Never add a browser-side `.update()` on these tables; `server/__tests__/learningIntegrity.test.js` checks this.
- "Ready for a higher level?" only counts tutor turns the server signed (`turnSignature` / `countVerifiedPriorStudentMessages` in `server/chat/readiness.js`; HMAC in `server/lib/turnSigning.js` with `LEAP_TURN_SECRET` or a key derived from the service-role key). The client keeps the signature on the assistant message (`sig`, stored in `retrieved_context.turnSig`). It is stripped before messages go to the model.
- Teacher analytics average per student first (`perStudentAverage`, `server/analytics/aggregate.js`), so many attempts by one student cannot dominate.
- Achievements are written only by the server (see `learning-journal-achievements.md`).

## Auth and profile cache
- Every `callerClient.auth.getUser()` goes through `userCache.getUser(authHeader, …)`, and every `profiles.select('role, email')` by id goes through `profileCache.get(id, loadProfileRoleEmail)` (instances in `server/lib/auth.js`, cache in `server/lib/authCache.js`).
  - TTL is 30 s and never runs past the token's `exp`.
  - Failures are not cached, and the cache is off in tests.
  - After deleting a user, call `userCache.forgetUser(id)` and `profileCache.invalidate(id)`.
  - `server/__tests__/authCache.test.js` fails on a new uncached copy.

## My data (own data)
- My data (`/my-data`, `server/account/myData.js`, routes `/api/me/export` and `/api/me/delete-account`): download everything as JSON, a printable learning record (`src/lib/learningDossier.ts`), and self-service account deletion (confirm with own email; not for admins).
  - New tables with a user column must be listed in `EXPORT_SOURCES` or `NOT_EXPORTED`; `server/__tests__/myData.test.js` checks this.
