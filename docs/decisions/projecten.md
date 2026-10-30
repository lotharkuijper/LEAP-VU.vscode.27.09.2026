# Projecten, groepen en persona's

Besluiten en werking van LEAP op dit gebied, zoals ze in de oude CLAUDE.md stonden. Geen instructies die altijd gelden, maar naslag: lees dit als je aan dit onderdeel werkt, en werk het bij als een besluit verandert.

## Projects, groups and project bots (personas)

Group content (group chat, persona conversations, sessions, feedback, relationship, group files) is for group members and LEAP admins only: `isLeapAdmin(profile)` plus membership (`isGroupMember` in `server/projects/access.js`), never `isStaffForCourse`. Full privacy model: `docs/decisions/privacy-en-data.md`.

### Project bots (personas)
- Three roles in `persona_type`:
  - `conversational` = Begeleider (guide);
  - `evaluator` = Beoordelaar (feedback on submitted work with a hidden rubric, `max_reviews` rounds per group, `deliverable_label`);
  - `roleplayer` = Rolspeler (character in a simulation).

  Field rules live in `server/projects/personaRoles.js` (`roleFieldsFrom`, `copyRoleFields`). Every create/copy/patch route for templates and project copies goes through them. The admin UI uses `PersonaRoleFields` for both editors.
- A relationship ("verstandhouding") exists ONLY for a role player with `reputation_enabled` (`reputationActive`). Guides and evaluators never get one, and the room shows no label for them.
- Levels are stored in `project_persona_relationships.score`: −2 cold … +2 warm, and −3 = contact broken.
  - After each closed conversation, a separate LLM judgement with the teacher's `conduct_rules` moves the level by at most one step (`server/projects/threadClose.js`, `threadCloseService.js`).
  - A negative step from cold breaks contact. The role player then no longer answers, and only a teacher correction (`relationship-adjust`, `{ level, note }`, `server/projects/relationshipAdjust.js`) restores it.
  - The conduct rules are never put in the persona's chat prompt; it only gets its level and the matching behaviour.
  - Students see the level and the latest reason.
- What a persona knows (2026-10-27, `server/projects/personaKnowledge.js`, `PersonaKnowledgeFields`, migration `20261027120000_persona_knowledge` + rollback). Per persona the teacher chooses, hidden from students:
  - `course_knowledge` `none|all|selected` (+ `course_knowledge_doc_ids`, course RAG documents only);
  - `project_knowledge_doc_ids` (project documents). New personas know NOTHING (only their instructions); `rag_enabled`/`rag_folder_ids` are no longer read.
  - Project documents a chat persona knows are chunked into `document_chunks` under their `document_ref_id` (Projectdata folder, outside the course RAG folders, so tutor/quiz/concepts never see them) and searched per question (`searchChunksServerSide(…, { documentIds })`, `server/rag/search.js`). Visible documents get a source number; hidden ones are background knowledge without a source. Not yet indexed → the start of the text goes along and indexing runs in the background.
  - Data files (`material_kind` `data`, or a data extension without another kind) are NEVER persona knowledge; the server filters them and removes a document from every persona when it is deleted or becomes data.
  - Evaluators read their documents in full (`loadEvaluatorMaterial`) for feedback rounds, "Beoordeling opvragen" and the pre-assessment; the rubric is a project document of kind `rubric` (old `project_persona_documents.is_hidden_rubric` rows were migrated and are no longer read). Every persona copy/create route uses `copyKnowledgeFields` / `knowledgeFieldsFrom` + `sanitizePersonaKnowledge` (`server/projects/personaRoutes.js`); `server/__tests__/personaKnowledge.test.js` guards this.
- Groups submit work to an evaluator via `POST …/groups/:groupId/personas/:personaId/feedback` (stored in `project_group_products`, reviewed by `runEvaluatorReview` in `server/projects/evaluatorReview.js`). A round only counts when a review was produced (`feedbackRoundsState`, `server/projects/documentReview.js`). Evaluator reviews do not change any relationship.
- Pre-assessment of the final product (2026-10-16, `server/projects/preassessment.js`, migration `20261016140000_project_preassessment` with rollback):
  - A teacher designates one Evaluator per project as pre-assessor (`projects.preassessment_persona_id`, `PUT …/preassessment-persona`). After every submission (`project_submissions`) the server reads the WHOLE product (in parts of ~18k characters plus a synthesis call) and stores a pre-assessment per criterion of that evaluator's hidden rubric in `project_submission_assessments`: strengths, concerns, quotes and an indication (`strong|adequate|weak|unclear`). Never a grade; the teacher assesses.
  - Grounded: quotes that do not literally occur in the product are dropped (`verifyQuotes`); instructions inside the product are ignored and reported under `attention`.
  - Only course teachers and LEAP admins see it (submissions are deliberately shared work). Students only see a notice that it happens. The pre-assessor is excluded from student feedback rounds, the room's evaluator list and "Beoordeling opvragen", so its rubric stays with the teacher.
  - Downloads: per submission a Word file (`…/preassessment.docx`), per project one zip (`…/submissions-export.zip`: per group the product + pre-assessment, plus an overview CSV). Check with `node --env-file=.env scripts/check-preassessment.mjs [--long]` (real model, test account, cleans up).

### Learning levels and journals in projects
- Learning levels play no role in projects. The project room has no level selector or readiness button, and the persona chat ignores `learningLevel`.
- Since 2026-10-27 the project NEVER writes to the journals of all group members. The texts stay with the group (`group_checkpoints.journal_items`, `project_document_reviews.journal_entry`, `project_group_assessments`; migration `20261027140000_project_journal_on_request` + rollback) and each member saves what they want to their OWN journal with "Bewaar in mijn leerdagboek" (`POST /api/projects/groups/:groupId/journal-save`, `server/projects/projectJournalSave.js`; one `source_ref` per item and user, older automatic refs count as saved; at the final reflection a member can add an own reflection). A finished group stays reachable read-only (`finishedGroup` in the student overview). `server/__tests__/projectJournalSave.test.js` and `server/__tests__/projectJournal.test.js` guard this.
- Project texts (interim checkpoint, final reflection, overview across conversations, summary per persona conversation, evaluator feedback rounds, "Beoordeling opvragen") use the journal blocks; structured input is converted without an extra LLM call (`server/projects/projectJournal.js`). See `docs/decisions/leren-met-ai.md`.
- Evaluator reports ("Beoordeling opvragen") are stored in `project_group_assessments` and shown in the project room; a member can save them to their own journal only when the journal switch is on (see `docs/decisions/cursusmateriaal-en-rag.md`).

### Project groups (2026-10-27)
- Each project has `group_mode` (`server/projects/projectGroups.js`, migration `20261027160000_project_group_modes` + rollback): `canvas` (default for canvas/canvas_open courses), `teacher` (default for open courses) or `self` (students form groups with an invite code; the old behaviour). `allow_self_signup` is kept in sync (= self) for old code.
- With `canvas` or `teacher` a student can never create, join, leave or restart a group (`studentMayFormGroups` guards `POST /api/projects/groups`, `/groups/join`, `/student-restart`; the UI hides those actions). The course teacher/admin manages groups via `/api/projects/:projectId/group-admin` (`ProjectGroupsAdmin`: create, rename, delete empty, assign/move, auto-divide unassigned students).
- The browser never creates or changes `project_groups` or `project_group_members` itself; the server does it with all checks (migration `20261030100000_security_hardening`). A teacher is never put into a student group via the server, and group management responses never contain invite codes; invite codes come from a cryptographic random source.
- Canvas group assignments (project link with `&project=<p>`): see `docs/decisions/toegang-en-canvas.md`. `server/__tests__/projectGroups.test.js`, `server/__tests__/lti.test.js`.
