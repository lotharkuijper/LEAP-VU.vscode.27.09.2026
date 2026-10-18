# LEAP-VU project instructions for Claude-style assistants

## Project overview
- This repository is the LEAP-VU learning platform.
- Stack: React + TypeScript + Vite frontend, Node/Express server, Supabase, Azure OpenAI, Postgres.
- The system is built around course document ingestion, RAG chunking, concept extraction, quiz generation, and teacher-scoped source validation.

## Core principles
- Prefer grounded answers over creative generation.
- Always validate quiz generation, teaching content, and concept extraction against actual course material and RAG evidence.
- Do not silently accept a "no result" state when document ingestion is broken.
- When a bug is found, fix the root cause and add a regression test.

## High-priority constraints
- The LLM should not be allowed to drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact.
- Question generation and concept extraction must be checked against real document chunks and embeddings, not just model creativity.
- Do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.

## RAG and ingestion rules
- Concept extraction reads the WHOLE course: all chunks per document, in windows of ~12k characters (`server/conceptConsolidation.js`), one LLM call per window, and every candidate keeps its `source_document_ids`. Never go back to a single sample of chunks (it used to cover 5% of E&B1).
- Duplicates are handled in three ways:
  - Sure cases are merged automatically (`planSureMerges`): spelling variants (`conceptKey`), and a concept whose name is stored as an alias of another concept. An extraction candidate that matches an existing alias is never inserted as a new concept.
  - Synonyms, abbreviations and translations go through the LLM synonym step (narrow, automatic); the other names are stored as `aliases`.
  - Doubtful cases are shown to the teacher as suggestions (`/api/admin/concepts/merge-suggestions`, broad prompt `buildDuplicateSuggestionPrompt`, including variants with a qualifier). Every concept should appear only once: a module concept that also exists as a course concept is listed first (`kind: 'crossClass'`), and the course concept is kept.
- Merging always goes through the DB function `merge_concepts`, which moves all references along.
- Minimum and maximum number of concepts are set per course on the Concepts step (`extraction.min_concepts` / `max_concepts`). Selection is `selectConcepts` (`server/conceptConsolidation.js`): one by one, highest match (RAG score on a fixed 0.40–0.90 scale, evidence count, multi-document core term) minus overlap (cosine to already chosen), with a small bonus for an unrepresented document. Below the minimum, top up only from candidates WITH evidence (≥1 chunk) under the evidence threshold, stored as `needs_review`; never without evidence. A shortfall is reported, not padded.
- The frontend runs extraction as a background job (`runConceptExtraction`), because a request of several minutes gets cut off by proxies. Every window retries rate limits, 5xx and network errors (ECONNRESET) and never throws; windows that still fail are named in the result message, never dropped silently (Microbiologie, 534 windows, 2026-10-18).
- Uploads are read in through one queue (`server/processingQueue.js`, 2 at a time; rate limits are re-queued, not failed). Count chunks in the database (GROUP BY), never by fetching chunk rows in the browser: the API returns at most 1000 rows.
- Searching across languages (`server/crossLingual.js`, `POST /api/rag/query-variants`): when the question's language differs from the course material's majority language, the server translates the question and `searchRelevantChunksWithStats` searches with both, keeping the best score per passage. Never blocking: on any failure it searches with the original question only.
- The tutor chat always gets a short course overview (`server/courseOverview.js`: name, description, leerlijn units or material titles, approved concepts) for orientation questions; it is explicitly not a source for content explanations.
- Verify chunking before concept extraction.
- A document that collapses into a single giant chunk is a failure mode and must be diagnosed.
- Office files should be converted to readable plain text; never write `[object Object]` into stored chunks.
- Do not assume Supabase or Azure config is correct without checking the live runtime config and DB records.

## Subject-neutral (2026-10-15)
- LEAP is not tied to one subject. UI texts and the fixed LLM instructions in code contain no subject content (no epidemiology or statistics examples); use neutral examples or examples from several fields. server/__tests__/subjectNeutral.test.js enforces this.
- The general chat and explain instructions in the DB are TEMPLATES (Sjabloon chat-instructie / Sjabloon Ik leg uit): the starting point a teacher adapts per course in Chat-instructies, and the fallback for courses without their own instruction. Subject content belongs in the per-course instruction. E&B1 has its own copy of the old E&B text.
- Concepts never leak between courses: /api/concepts returns only the course's own concepts (no fallback to concepts without a course; without a course only the manage view sees everything). Query expansion uses only the concept's own aliases, key points and definition, with no static synonym list.

## Testing expectations
- Prefer real behavior tests over mock-only assertions.
- For ingestion and chunking fixes, add a reproduction/regression test.
- Before claiming success, run the smallest relevant test suite.

## Common verification commands
- `npx vitest run server/__tests__/ragProcessing.test.js`
- `npx vitest run server/__tests__/conceptExtraction.test.js`
- `npm run dev`
- `node --env-file=.env scripts/check-document-viewer.mjs`: document viewer in a real browser (text layer for selecting and copying, zoom, full screen via the Fullscreen API, "Vraag in de chat").

## Code quality expectations
- Keep fixes minimal and targeted.
- Preserve existing server/frontend architecture unless required by the bug.
- Record the root cause and the verification evidence in the change notes or in the conversation.

## Language and help texts
- No user-visible text may exist only in Dutch. Every UI string goes through i18n (`t('key')` in components, `tStatic(getActiveLang(), 'key')` elsewhere); `src/i18n/locales/nl.json` is the source of truth, `en.json` is maintained by hand, and the other languages are filled with `node --env-file=.env scripts/i18n-generate.mjs` (re-run until "RESTEREND totaal: 0"). The locale parity test must pass.
- Server messages shown to users (JSON `error`/`message`) are translated centrally by the response middleware in `server/serverI18n.js` using the language the client sends; add new messages to that dictionary (see the file header) instead of hard-coding per-language text.
- Prompts sent to the language model are not UI text and stay as they are.
- Help texts in the admin ("?" buttons, `src/components/help/HelpTip.tsx`) belong to a FUNCTION, not a place: ids live in `src/help/helpTopics.ts`, texts under `help.<id>.title/body`. When restructuring the admin, move the `<HelpTip>` with its control, update the text if the behaviour changed, and remove the id when a function disappears. `src/help/__tests__/helpTopics.test.ts` fails on unknown, unused or stray help ids.
- Icon-only buttons get `<Tooltip label={t(…)}>` (`src/components/help/Tooltip.tsx`: hover + keyboard focus, sets aria-label) instead of `title=`. Explanation text in the admin uses `<AdminHint variant="intro|tip|warning">` (`src/components/help/AdminHint.tsx`) instead of ad-hoc grey lines or blue boxes; `tip` and all HelpTips disappear when the teacher switches "Uitleg tonen" off (`HelpToggle`, `helpVisibility.ts`).
- Generic button/status words use `common.*` keys (e.g. `common.cancelAction`, `common.busy`), never a key borrowed from an unrelated feature namespace.

## Look and feel
- Colours come from the LEAP palette: CSS variables `--leap-brand-*`, `--leap-ink-*`, `--leap-accent-*` in `src/index.css`, wired up in `tailwind.config.js`. Use `brand-*` for the main colour, `ink-*` for neutrals and `accent-*` for successes/rewards. `blue`/`sky` map to brand and `gray`/`slate` to ink, so existing classes follow the palette. Never hard-code hex colours in components.
- Font: Nunito, self-hosted via `@fontsource-variable/nunito` (no Google Fonts link). Formulas are rendered by KaTeX in its own fonts.

## Learning journal
- Automatic journal entries (reflections) are stored in three blocks: summary, feedback (went well / to improve) and next steps, in `learning_journal_entries.sections`, plus `learning_level` (the student's level at that moment, where applicable). New generators append `journalFormatInstruction(lang)` to the prompt and save `...journalFieldsFromModel(text, lang)` (`server/journalSections.js`); `content` always stays filled as readable text. The model uses fixed `### SUMMARY` etc. headings, not JSON, so LaTeX survives.
- Project entries (interim checkpoint, final reflection, overview across conversations, summary per persona conversation) use the same blocks. Structured input is converted without an extra LLM call (`server/projectJournal.js`); free text is generated in blocks directly. Every journal insert in the checkpoint route passes `sections`; `server/__tests__/projectJournal.test.js` checks this.
- Learning levels play no role in projects. The project room has no level selector or readiness button, and the persona chat ignores `learningLevel`.
- In the chat the level really changes the language. `server/learningLevel.js` has a level table (`LEVEL_PROFILES`) with six dimensions: language (CEFR B1→C2), terminology, sentences, abstraction, prior knowledge and step size, plus the answer length. The teacher's chat prompt and the level complement each other; neither overrules the other. The teacher decides the KIND of response: role, approach (e.g. Socratic), structure, tone and limits such as a maximum length. The level decides HOW technical and complex the answer is within that frame: language, terminology, abstraction, prior knowledge and the difficulty of a question. Length sits at the short or long end of the teacher's limit. The teacher's approach is carried out AT the level; for example, "start from what the student knows" means everyday experience at level 1 and a deeper aspect at level 5. Teachers do not need to specify language level in their prompt (help text `chatInstructions.overview`). Check changes with `node --env-file=.env scripts/eval-level-language.mjs` (real model, test account): LIX must rise from level 1 to 5, level 1 has at most ~1 technical term, and level 5 is at least 10 LIX points above level 1.
- They play no role in "Ik leg uit" either (decided 2026-10-15): you master a concept or you do not. There is no selector, no level in the assessment, and no `learning_level` on explanation reflections. The level is chosen only in the chat.

## Achievements
- Earned, never clicked: choosing a higher level in `LearningLevelSelector` has no celebration. The celebration (`LevelUpCelebration`) plus an achievement only follow a positive, server-validated verdict on "Ready for a higher level?" in the chat (`readinessCheck: true` → `server/readiness.js`). The tutor appends an invisible `[[LEAP_READINESS …]]` label that the server always strips. The server decides eligibility itself: level from the DB, a minimum amount of student input, and the topic must be an approved course concept.
- Achievements live in `student_achievements` (written only by the server; students read their own rows via RLS), are unique per (user, course, kind, topic_key, level), and point to a journal entry as evidence. Future kinds (quiz, project badges, learning goals) reuse this table.

## Project bots (personas)
- Three roles in `persona_type`:
  - `conversational` = Begeleider (guide);
  - `evaluator` = Beoordelaar (feedback on submitted work with a hidden rubric, `max_reviews` rounds per group, `deliverable_label`);
  - `roleplayer` = Rolspeler (character in a simulation).

  Field rules live in `server/personaRoles.js` (`roleFieldsFrom`, `copyRoleFields`). Every create/copy/patch route for templates and project copies goes through them. The admin UI uses `PersonaRoleFields` for both editors.
- A relationship ("verstandhouding") exists ONLY for a role player with `reputation_enabled` (`reputationActive`). Guides and evaluators never get one, and the room shows no label for them.
- Levels are stored in `project_persona_relationships.score`: −2 cold … +2 warm, and −3 = contact broken.
  - After each closed conversation, a separate LLM judgement with the teacher's `conduct_rules` moves the level by at most one step (`server/threadClose.js`).
  - A negative step from cold breaks contact. The role player then no longer answers, and only a teacher correction (`relationship-adjust`, `{ level, note }`) restores it.
  - The conduct rules are never put in the persona's chat prompt; it only gets its level and the matching behaviour.
  - Students see the level and the latest reason.
- Groups submit work to an evaluator via `POST …/groups/:groupId/personas/:personaId/feedback` (stored in `project_group_products`, reviewed by `runEvaluatorReview`). A round only counts when a review was produced (`feedbackRoundsState`). Evaluator reviews do not change any relationship.
- Pre-assessment of the final product (2026-10-16, `server/preassessment.js`, migration `20261016140000_project_preassessment` with rollback):
  - A teacher designates one Evaluator per project as pre-assessor (`projects.preassessment_persona_id`, `PUT …/preassessment-persona`). After every submission (`project_submissions`) the server reads the WHOLE product (in parts of ~18k characters plus a synthesis call) and stores a pre-assessment per criterion of that evaluator's hidden rubric in `project_submission_assessments`: strengths, concerns, quotes and an indication (`strong|adequate|weak|unclear`). Never a grade; the teacher assesses.
  - Grounded: quotes that do not literally occur in the product are dropped (`verifyQuotes`); instructions inside the product are ignored and reported under `attention`.
  - Only course teachers and LEAP admins see it (submissions are deliberately shared work). Students only see a notice that it happens. The pre-assessor is excluded from student feedback rounds, the room's evaluator list and "Beoordeling opvragen", so its rubric stays with the teacher.
  - Downloads: per submission a Word file (`…/preassessment.docx`), per project one zip (`…/submissions-export.zip`: per group the product + pre-assessment, plus an overview CSV). Check with `node --env-file=.env scripts/check-preassessment.mjs [--long]` (real model, test account, cleans up).
- Admin modals that can grow taller than the screen are rendered with `createPortal(…, document.body)`. The sticky top bar is z-50, and a modal inside the page content would fall behind it.

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
- Group content is for group members and LEAP admins only. In the server use `isLeapAdmin(profile)` plus membership, never `isStaffForCourse` for group content. In the database: migration `20261008100000_teacher_privacy` (rollback script next to it).
- `server/__tests__/teacherPrivacy.test.js` guards this.
- Roles can only be changed by an admin or the server (trigger `pr_guard_profile_role`).

## Design assistant ("Ontwerphulp")
- This is an optional chatbot for teachers in Beheer: a side panel (`DesignAssistantDock`) opened from a tab on the right edge, available in every Beheer section and kept open while switching sections. It knows where the teacher is (`describePlace`). It is an experiment since 2026-10-07. The rollback point is git tag `pre-ontwerphulp-2026-10-07`, and the admin can switch it off via the gear in the panel.
- It must keep up with the engine. Its knowledge of LEAP is NEVER hand-written in the prompt; it is assembled per question in `server/designAssistant.js` from:
  - `ADMIN_SECTIONS` (tabs + who may use them);
  - the help texts (`help.*` in nl.json);
  - the fixed knowledge documents `KNOWLEDGE_DOCS`, always read in full (no retrieval step): the manual (`docs/handleiding/handleiding.html`) and the project step-by-step plan (`docs/handleiding/Stappenplan-project-LEAP.docx`, read straight from Word via `docxToText`, so edits in Word count). Both are copied into the Docker image; each must stay under `KNOWLEDGE_DOC_LIMIT` (a test fails otherwise, so nothing is cut silently);
  - the course state, fetched through the existing admin routes with the teacher's token.
- Its knowledge is 100% separate from course material (decided 2026-10-16): files in the repo only, never `documents`/`document_chunks`, nothing else in LEAP reads it, and teachers cannot change it. No external sources (no vu.nl pages). The didactic way of working lives in `DEFAULT_DESIGN_ASSISTANT_PROMPT`: constructive alignment, scaffolding, activating and blended education, varied assessment (LEAP activities are formative practice spaces, never a grade source), with the VU values open, personal and responsible in the background. It does not invent VU/faculty rules and refers to the programme and the VU Centre for Teaching & Learning.
- When you add, remove or re-permission an admin tab, or add a new help-text group, update `ADMIN_SECTIONS`. `server/__tests__/designAssistant.test.js` fails until you do.
- Only the admin can change the bot's way of working (prompt) and the on/off switch (chatbot_prompts rows `__design_assistant_prompt__` / `__design_assistant_enabled__`). The bot never changes anything itself; it gives advice and drafts.

## Analytics (tab "Analyse", since 2026-10-09)
- A deliberately LOOSE module, so it can be removed as one piece. Server code lives in `server/analytics/`, frontend in `src/features/analytics/`. The header of `server/analytics/index.js` lists every touchpoint elsewhere: one import and one `installAnalytics(…)` call in `server/index.js`, `purpose: 'tutor_chat'` in `sendChatMessage`, the tab in `AdminPage`, `ADMIN_SECTIONS`, the help ids and the locale keys. Do not call analytics code from other modules; `server/__tests__/analytics.test.js` checks that `server/index.js` touches it only through that one import and call.
- Only aggregates, never people:
  - The table `analytics_counters` holds counters per (week, course, kind, key) with no user ids, no timestamps and no question text. Migration `20261009100000_analytics_counters`, rollback script next to it.
  - Quiz figures are computed live from `quiz_attempts` and hidden below `K_MIN` = 5 distinct students (per concept, per course and per week).
- Measuring happens in one middleware (requests, duration, 5xx errors) and a wrapper around global `fetch` (Azure OpenAI `usage` tokens, attributed to the running request via AsyncLocalStorage). Tutor-chat questions are matched against concept names and aliases in memory, and only the concept name is counted. Measuring must never break a request: every hook is wrapped in try/catch, and a missing table pauses writing.
- Teachers see the concept thermometer for their own course (`isStaffForCourse`). Platform health and costs are for LEAP admins only.

## Learning data integrity (2026-10-09)
- The browser writes quiz attempts, journal entries and learning levels directly, so the database guards them (migration `20261009120000_learning_data_integrity`, with rollback):
  - The course must be usable by the user (`leap_can_use_course`).
  - Quiz scores are recomputed by the trigger `quiz_attempt_rescore`: multiple choice against the answer key, open answers clamped to 0–100.
  - Attempts cannot be updated afterwards; students may delete their own.
  - Students cannot update journal entries. Never add a browser-side `.update()` on these tables; `server/__tests__/learningIntegrity.test.js` checks this.
- "Ready for a higher level?" only counts tutor turns the server signed (`turnSignature` / `countVerifiedPriorStudentMessages` in `server/readiness.js`; HMAC with `LEAP_TURN_SECRET` or a key derived from the service-role key). The client keeps the signature on the assistant message (`sig`, stored in `retrieved_context.turnSig`). It is stripped before messages go to the model.
- Teacher analytics average per student first (`perStudentAverage`), so many attempts by one student cannot dominate.

## Auth and profile cache
- Every `callerClient.auth.getUser()` goes through `userCache.getUser(authHeader, …)`, and every `profiles.select('role, email')` by id goes through `profileCache.get(id, loadProfileRoleEmail)` (`server/authCache.js`).
  - TTL is 30 s and never runs past the token's `exp`.
  - Failures are not cached, and the cache is off in tests.
  - After deleting a user, call `userCache.forgetUser(id)` and `profileCache.invalidate(id)`.
  - `server/__tests__/authCache.test.js` fails on a new uncached copy.

## Student-facing learning loop and own data
- "Your progress" on the quiz page (`src/lib/conceptProgress.ts`, client only, the student's own attempts) does spaced repetition: weak first, then due, then new.
  - The default difficulty follows the learning level.
  - `/quiz?concept=<id>&name=<name>` preselects a concept; Explain links to it.
- My data (`/my-data`, `server/myData.js`): download everything as JSON, a printable learning record (`src/lib/learningDossier.ts`), and self-service account deletion (confirm with own email; not for admins).
  - New tables with a user column must be listed in `EXPORT_SOURCES` or `NOT_EXPORTED`; `server/__tests__/myData.test.js` checks this.

## Course features on/off (2026-10-15)
- Teachers switch student parts per course in Beheer → Onderdelen (`CourseFeaturesAdminTab`): chat, explain, quiz, projects, journal, studiecafe. `courses.features` stores only what is OFF (`{"quiz": false}`); a missing key means on. Switching off hides, it never deletes.
- One rule everywhere: `server/courseFeatures.js` (server) and `src/lib/courseFeatures.ts` (browser, must stay identical; a test compares them). Course teachers and admins keep using a disabled part, labelled "uit voor studenten".
- Enforced in three layers:
  - browser: menu, dashboard tiles, `CourseFeatureGate` per page (in `ProtectedRoute`), and links between parts (`useCourseFeatures().visible(f)`);
  - server: `rejectIfFeatureOff` / `courseFeatureOnFor`. `/api/chat` serves chat, explain and quiz, so only the part named by `featureForChatRequest` is blocked;
  - database: `leap_course_feature_on` in the insert policies of conversations, quiz_attempts and learning_journal_entries (migration `20261015100000_course_features`, rollback next to it).
- Every server write to `learning_journal_entries` must first check the journal switch; `server/__tests__/courseFeatures.test.js` fails otherwise. Evaluator reports ("Beoordeling opvragen") are always stored in `project_group_assessments` and shown in the project room, and in the journal only when it is on.
## Attachments in the chat (2026-10-16)
- Students can paste an image (Windows+Shift+S), pick one via the paperclip, drag one in, or add a file (PDF, DOCX, PPTX, ODT/ODP, TXT, MD) in the tutor chat. Plan and test results: `docs/plans/chat-bijlagen-plan.html`, `docs/plans/chat-bijlagen-fase0.md`.
- Two switches, both needed:
  - the admin's master switch (chatbot_prompts row `__chat_attachments__`, admin → Instellingen; OFF by default, the emergency brake for everyone; switching off keeps each course's choice);
  - the course switch `attachments`, an OPT-IN feature (`OPT_IN_FEATURES` in `server/courseFeatures.js` and `src/lib/courseFeatures.ts`): on only with `{"attachments": true}`. Switching on needs the warning + second confirmation (`confirmAttachments: true`). Changes go to `leap_setting_changes`.
- NOTHING is stored. Attachments live in browser memory only (`useChatAttachments`) and are forgotten when the chat is closed. Messages store only a label (`retrieved_context.attachments`: kind, name, size, pages). The database rejects inline files (`data:…;base64,`) in `messages` and the Studiecafé tables (migration `20261016100000_chat_attachments`); `stashStudiecafeHandoff` refuses them too. Never log attachment content.
- An image is sent to the model once (the tutor starts with "Dit zie ik:"); file text is sent with every turn (capped). The attachment block goes BEFORE the language/level block in the system prompt. A typed explanation is required with every attachment.
- Default detail level is HIGH: in the 16-10 test, low detail invented content on a full page of small text. Re-check with `node --env-file=.env scripts/eval-chat-attachments.mjs <dir>`, `scripts/check-chat-attachments.mjs` (API) and `scripts/check-chat-attachments-ui.mjs` (browser). The daily limit counter is held in process memory (single replica).

## Learning path / leerlijn (2026-10-16)
- Teachers can order course material into units (Beheer → Cursusmateriaal → Bestanden → Leerlijn): `course_units` (position; EQUAL position = side by side) and `course_unit_documents` (per course). NO dates: it is the build-up of the material, not a schedule (students outside the course period and externals). Proposal from file numbering (`proposeUnits`). Code: `server/courseUnits.js`, migration `20261016130000_course_units` (+ rollback).
- Tutor chat: the question sets the anchor (unit with most similarity among the sources, or the student's own choice "Ik werk aan …", stored only in the browser). The leerlijn block (before the language/level block) labels units earlier / anchor / parallel / later; the tutor builds on earlier units and refers ahead sparingly, EXCEPT to units the student already practised (own quiz attempts, explanations and chat sources, `practiceByUnit`, threshold 2). Retrieval is never restricted.
- Re-check with `node --env-file=.env scripts/eval-leerlijn.mjs` (real model, no writes): later-unit terms must drop with the leerlijn (B < A) and come back when that unit was practised (C > B).

## System messages (2026-10-16)
- The admin sends one-way messages (Beheer → Berichten, admin only) to all users, all students (profile role student), all teachers (profile role docent), or one course (students only, or everyone in it). Optional start and end time; kind info or warning. Code: `server/systemMessages.js` (one `registerSystemMessageRoutes` call in `server/index.js`), migration `20261016120000_system_messages` (+ rollback).
- Messages show at the top of the Dashboard until dismissed; while one is open, "Dashboard" in the menu shows a red exclamation mark (not on the Dashboard itself). One shared store, `src/lib/systemMessages.ts`, polls every 2 minutes and on tab focus (no Realtime on Azure). Text is translated on display (`useContentTranslation`), not in the admin preview.
- Privacy: only the fact that a user dismissed a message is stored (`system_message_dismissals`, in My data export); the admin sees totals only (recipients, dismissed), never names.

## "Ik leg uit" feedback (2026-10-15)
- `POST /api/explain/evaluate` assesses, scores and saves in one step; the browser only sends the explanation plus the course fragments it found. There is no browser-side save of feedback or score.
- The server always appends `explainFormatInstruction` (`server/explainFeedback.js`) to the teacher's explain prompt. The prompt sets the tone; the block fixes the structure:
  - `### FEEDBACK`: only about THIS concept and its definition. A related concept is never a shortcoming.
  - `### SCORE`: 0–100 on a fixed scale. Start at 100. A reasonably good explanation is 70–90, a good one is 100.
  - `### RELATED`: at most 3 concepts, only from approved course concepts that share evidence fragments (`rankRelatedConcepts`). They do not count towards the score.
  - `### FEEDFORWARD`: 1–2 next steps.
- Stored as `student_explanations.feedback = { content, sections }` and `score = { total, reason }`. The score is shown only to the student, not in progress or analytics (decision 2026-10-15).
- `concepts.key_points` contains technical labels (`course_id:…`, `[RAG-…]`) and no real key points. Always filter them out (`cleanKeyPoints` / `realKeyPoints`) before they reach a prompt or a search query.
- Calibration against the real model (prospective cohort study): excellent 100, reasonable 85, confused 40, wrong 30. Re-check with a live run after changing the scale.
## Background tasks
- Admin actions that take longer than a few seconds run as a background task via `startTask` (`src/lib/backgroundTasks.ts`), not only inside the component. Examples: extracting concepts, uploading files, importing or updating websites, and ShareStats imports.
- A task keeps running when the user moves to another part of the app. The task tray (`TaskTray`, bottom right) shows progress and a "… is done — View result" notice with a link back.
- Work that runs on the server gets `where: 'server'` and a resumer, so it also survives a page reload. Work the browser does itself gets `where: 'browser'`, and the app warns before the tab is closed.
- Report progress as `{ done, total, labelKey }`. Components read a task that is still running through `useTask(kind, key)`, so they show its progress again when the user comes back.

## Layout
- List rows in the admin (title + badges + buttons) use `ListRow` / `RowActions` (`src/components/ui/`): buttons that do not fit go into "⋯ More", dangerous actions always sit there, separated and in red. Never build a `flex justify-between` row with a button group that is not allowed to shrink.
- Flex children that hold text get `min-w-0`; buttons get `whitespace-nowrap` inside a row that may wrap (`flex-wrap`). Grids inside the admin choose columns by the available space (`grid-cols-[repeat(auto-fill,minmax(min(Xrem,100%),1fr))]`), not by the screen width: the admin content column is much narrower than the screen.
- Check layout with `npm run ui:audit` (Edge via playwright-core; test account via `node --env-file=.env scripts/ui-audit-account.mjs create`). It opens every page and admin tab at 390/1024/1366 px and reports squeezed text, overlap, content sticking out of its card and horizontal scrolling. The report goes to `ui-audit-output/`.

## Hosting on Azure
- LEAP can run on Azure (resource group `vu-leap-rg`); the setup and runbook live in `azure/` (`azure/README.md`). Supabase stays the API: Auth (GoTrue), PostgREST and Storage are self-hosted there, so keep using the Supabase client, RLS and `supabase/migrations/` as before. Do not replace them with Azure-native services.
- A push to `main` deploys (`.github/workflows/azure-deploy.yml`; active once the repo variable `AZURE_CLIENT_ID` is set). New files in `supabase/migrations/` are applied by the app at start-up (`scripts/migrate.mjs`, tracked in `public.leap_migrations`); a failing migration keeps the previous version running. Name migrations `<YYYYMMDDHHMMSS>_<name>.sql` and make each one runnable exactly once.
- Supabase Realtime and Edge Functions do not exist on Azure. Anything that listens for database changes goes through `liveUpdates` (`src/lib/liveUpdates.ts`), which subscribes where Realtime exists and refreshes periodically where it does not. Do not call `supabase.functions.invoke`; add an Express route instead.
- E-mail goes through `getEmailConfig()` / `sendEmail()` (`server/notifications.js`): Azure Communication Services on Azure (sender `leap@vu-edulab.nl`, a send-only domain, so replies go to `MAIL_REPLY_TO`), Resend elsewhere. Account e-mails (confirm, invite, password reset) are built in `server/authEmailHook.js`, texts under `email.auth.*`. The limit is 30 e-mails per minute and 100 per hour.
- The app runs as exactly one always-on replica: jobs and timers held in process memory (`conceptJobs`, the Studiecafé digest) must be persisted in the database before scaling out.
- Secrets live in Key Vault (`kv-vu-leap`), never in the repo or in GitHub; the repo is public.

## Sensitive notes
- Do not put secrets in the repo.
- Trust `.env` values only when they are actually loaded and resolved in the runtime environment.
- For Azure calls, use the configured deployment names and API version; do not silently fallback to public OpenAI for embeddings.
