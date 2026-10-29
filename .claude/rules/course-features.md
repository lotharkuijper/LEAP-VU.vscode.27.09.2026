---
paths:
  - "server/courses/courseFeatures.js"
  - "src/lib/courseFeatures.ts"
  - "server/lib/courseFeatureGate.js"
  - "src/hooks/useCourseFeatures.ts"
  - "src/components/CourseFeatureGate.tsx"
  - "src/pages/admin/{CourseFeaturesAdminTab,CourseAttachmentsSetting,ChatAttachmentsPlatformPanel}.tsx"
  - "src/App.tsx"
  - "server/journal/**"
---

# Course features on/off (2026-10-15)

- Teachers switch student parts per course in Beheer → Onderdelen aan/uit (`CourseFeaturesAdminTab`): chat, explain, quiz, projects, journal, studiecafe. `courses.features` stores only what is OFF (`{"quiz": false}`); a missing key means on. Switching off hides, it never deletes.
- One rule everywhere: `server/courses/courseFeatures.js` (server) and `src/lib/courseFeatures.ts` (browser, must stay identical; a test compares them). Course teachers and admins keep using a disabled part, labelled "uit voor studenten".
- Enforced in three layers:
  - browser: menu, dashboard tiles, `CourseFeatureGate` per page (in `ProtectedRoute`, `src/App.tsx`), and links between parts (`useCourseFeatures().visible(f)`);
  - server: `rejectIfFeatureOff` / `courseFeatureOnFor` (`server/lib/courseFeatureGate.js`). `/api/chat` serves chat, explain and quiz, so only the part named by `featureForChatRequest` is blocked;
  - database: `leap_course_feature_on` in the insert policies of conversations, quiz_attempts and learning_journal_entries (migration `20261015100000_course_features`, rollback in `supabase/rollback/`).
- Every server write to `learning_journal_entries` must first check the journal switch; `server/__tests__/courseFeatures.test.js` fails otherwise. Evaluator reports ("Beoordeling opvragen") are stored in `project_group_assessments` and shown in the project room; a member can save them to their own journal only when it is on.
- OPT-IN features (`OPT_IN_FEATURES`; on only with an explicit `true`): `attachments` (see `chat-tutor.md`) and `formulaEditor` (see `formulas.md`).
- Sub-switches of explain: `explainSelf` / `explainImprove` (`EXPLAIN_PARTS`; see `explain.md`).
