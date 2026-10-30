---
paths:
  - "server/courses/**"
  - "server/lib/auth.js"
  - "src/pages/{ChooseCoursePage,LoginPage,ActivatePage,InviteAcceptPage,CoursesAdminPage}.tsx"
  - "src/components/{EnrollmentModeDialog,CoursesAdmin}.tsx"
  - "src/pages/admin/AddUsersTab.tsx"
  - "src/services/enrollment.service.ts"
  - "scripts/check-course-invitations.mjs"
---

# Course access, open registration and invitations

## Course access and open registration (2026-10-20)
- Access to a course = membership (`course_members`) or being its teacher; admins see everything. There is no longer a fallback to "every active, visible course". Server: `userHasCourseAccess` (`server/lib/auth.js`) / `canAccessCourseContent` (`server/courses/courseAvailability.js`); database: `is_course_member` in `course_content_is_public`, `sc_can_read_course` and the courses SELECT policy (migration `20261020100000_course_enrollment_mode`, rollback in `supabase/rollback/`).
- Each course has an access route `courses.enrollment_mode`: `closed`, `canvas`, `open` (default for now) or `canvas_open` (exception; needs `confirmBoth`). Only the admin sets it (`PUT /api/admin/courses/:id/enrollment-mode`, logged in `leap_setting_changes`); teachers only see the label. Code: `server/courses/enrollment.js`, dialog `EnrollmentModeDialog`.
- Open registration (`POST /api/auth/register`) requires choosing at least one open course; the choice waits in `pending_course_enrollments` and becomes membership after the e-mail is confirmed and the user logs in (`/api/me/activate-enrollments`). VU addresses (vu.nl and subdomains) are refused for open registration and self-join: VU students come via Canvas (VUnet-id lists, not built yet).
- Students can add an open course themselves on Kies cursus (`/api/courses/:courseId/join`) and leave it again. Teachers add students to their course and may promote them to teacher (Beheer leden).
- Disposable e-mail domains are refused at open registration (`isDisposableEmail`), max 10 registrations per IP per hour. Token budget for open accounts: see `analytics-and-token-budget.md`.
- Re-check with `server/__tests__/enrollment.test.js`.

## Inviting students (2026-10-26)
- Beheer → Studenten uitnodigen (`AddUsersTab`, `server/courses/courseInvitations.js`, migration `20261026120000_course_invitations` + rollback): a course teacher or admin enters e-mail addresses. Existing account → enrolled as student at once (never overwrites an existing membership), plus a short mail; active course unchanged. No account → LEAP creates it UNCONFIRMED (`createUser`, no auth mail), enrolls it, sets it as active course and queues a personal invitation ("<teacher> nodigt je uit voor <course>"). Role student, unless added via "Docent toevoegen" (below).
- "Docent toevoegen" (Beheer leden, 2026-10-27) uses the same route with `role: 'teacher'`: new or existing account becomes course teacher, a student of the course is promoted (`status: 'promoted'`, no mail), and the mail names the teacher role (`introTeacher`). Every path that makes someone course teacher calls `promoteCourseTeacherProfile` (`server/courses/teacherProfile.js`; profile `docent`, needed by the project/storage RLS), including the pgPool path of `PUT …/members/:userId` (live uses that path) and a Canvas teacher launch. After creating a course the admin sees next steps: Docent toevoegen, Toegangsroute kiezen, Naar cursusmateriaal.
- Invitations ignore the course access route and the VU-address block (Canvas exceptions, closed courses): the teacher vouches; `invited_by` is stored and named in the mail.
- The mail link is `/invite#t=<id.HMAC>` (key `TURN_SECRET`), valid 30 days from the last mail; only on click does `POST /api/invitations/accept` create a one-time login code (`generateLink` invite/magiclink, the GoTrue link itself would expire after a day). New accounts then choose a password on `/activate`.
- Mails go through a DB queue (`mail_status`), max ~20/min and 80/hour, retried 3 times. Teachers: max 300 invitations per 24 h (admins unlimited). Beheer leden shows pending invitations with resend/revoke. Unaccepted after 30 days: membership, invitation and the account are removed, but only an account that was never used (`isUnusedAccount`) and serves nothing else (`deleteIfOrphaned`, then `forgetUser`).
- Tests: `server/__tests__/courseInvitations.test.js`; end-to-end against the DB: `node --env-file=.env scripts/check-course-invitations.mjs` (API on :3001, test account, cleans up).

Canvas (LTI) launches and e-mail-code login: see `canvas-lti.md`.
