# Chat, Ik leg uit, quiz en leerdagboek

Besluiten en werking van LEAP op dit gebied, zoals ze in de oude CLAUDE.md stonden. Geen instructies die altijd gelden, maar naslag: lees dit als je aan dit onderdeel werkt, en werk het bij als een besluit verandert.

## Tutor chat

Order of blocks in the tutor system prompt: the attachment block, the chat-goal block and the leerlijn block (see `docs/decisions/cursusmateriaal-en-rag.md`) all go BEFORE the language/level block.

The tutor chat always gets a short course overview (`server/courses/courseOverview.js`); it is for orientation questions, never a source for content explanations (see `docs/decisions/cursusmateriaal-en-rag.md`).

### Learning level in the chat
- In the chat the level really changes the language. `server/chat/learningLevel.js` has a level table (`LEVEL_PROFILES`) with six dimensions: language (CEFR B1→C2), terminology, sentences, abstraction, prior knowledge and step size, plus the answer length. The teacher's chat prompt and the level complement each other; neither overrules the other. The teacher decides the KIND of response: role, approach (e.g. Socratic), structure, tone and limits such as a maximum length. The level decides HOW technical and complex the answer is within that frame: language, terminology, abstraction, prior knowledge and the difficulty of a question. Length sits at the short or long end of the teacher's limit. The teacher's approach is carried out AT the level; for example, "start from what the student knows" means everyday experience at level 1 and a deeper aspect at level 5. Teachers do not need to specify language level in their prompt (help text `chatInstructions.overview`). Check changes with `node --env-file=.env scripts/eval-level-language.mjs` (real model, test account): LIX must rise from level 1 to 5, level 1 has at most ~1 technical term, and level 5 is at least 10 LIX points above level 1.
- The level is chosen only in the chat. It plays no role in "Ik leg uit" (see `docs/decisions/leren-met-ai.md`) or in projects (see `docs/decisions/projecten.md`).
- "Ready for a higher level?", achievements and turn signing: see `docs/decisions/leren-met-ai.md` and `docs/decisions/privacy-en-data.md`.

### Optional goal in the chat (2026-10-20)
- The student may set a goal for a chat conversation with the "Doel" button (`src/components/chat/ChatGoal.tsx`, `server/chat/chatGoal.js`). Never required, invisible to teachers, no analytics or achievements. It is sent as `chatGoal` with each tutor-chat request and becomes a block BEFORE the language/level block (treated as the student's wish, not an instruction; the teacher's approach stays leading). It is stored only as a label on the student's messages (`retrieved_context.chatGoal`, `null` = removed), restored when the conversation is reopened, and the journal reflection at closing says how far the student got (`lastChatGoal` / `chatGoalSummaryLine`). `server/__tests__/chatGoal.test.js`.

### Chat reflection in the journal (2026-10-27)
- Students can save a reflection on a chat conversation at any time with "Opslaan in leerdagboek" (`POST /api/chat/reflect`); the conversation stays so they can continue later. `createChatReflection` (`server/chat/routes.js`) is shared with delete-with-summary (`/api/chat/delete`): it checks the journal switch, reflects only on messages since the previous save of that conversation (`source_ref` `chat:<conversation>:<last message id>`, earlier part as context only, title "(deel n)"), and returns `nothingNew` instead of writing a duplicate. `server/__tests__/chatReflect.test.js`.

### Attachments in the chat (2026-10-16)
- Students can paste an image (Windows+Shift+S), pick one via the paperclip, drag one in, or add a file (PDF, DOCX, PPTX, ODT/ODP, TXT, MD) in the tutor chat. Plan and test results: `docs/plans/chat-bijlagen-plan.html`, `docs/plans/chat-bijlagen-fase0.md`.
- Two switches, both needed:
  - the admin's master switch (chatbot_prompts row `__chat_attachments__`, admin → Instellingen; OFF by default, the emergency brake for everyone; switching off keeps each course's choice);
  - the course switch `attachments`, an OPT-IN feature (`OPT_IN_FEATURES` in `server/courses/courseFeatures.js` and `src/lib/courseFeatures.ts`): on only with `{"attachments": true}`. Switching on needs the warning + second confirmation (`confirmAttachments: true`). Changes go to `leap_setting_changes`.
- NOTHING is stored. Attachments live in browser memory only (`useChatAttachments`) and are forgotten when the chat is closed. Messages store only a label (`retrieved_context.attachments`: kind, name, size, pages). The database rejects inline files (`data:…;base64,`) in `messages` and the Studiecafé tables (migration `20261016100000_chat_attachments`); `stashStudiecafeHandoff` (`src/lib/studiecafeHandoff.ts`) refuses them too. Never log attachment content.
- An image is sent to the model once (the tutor starts with "Dit zie ik:"); file text is sent with every turn (capped). The attachment block goes BEFORE the language/level block in the system prompt. A typed explanation is required with every attachment.
- Default detail level is HIGH: in the 16-10 test, low detail invented content on a full page of small text. Re-check with `node --env-file=.env scripts/eval-chat-attachments.mjs <dir>`, `scripts/check-chat-attachments.mjs` (API) and `scripts/check-chat-attachments-ui.mjs` (browser). The daily limit counter is held in process memory (single replica).

## "Ik leg uit" (explain) and "Verbeter deze uitleg"

### No learning levels here (decided 2026-10-15)
- Learning levels play no role in "Ik leg uit": you master a concept or you do not. There is no selector, no level in the assessment, and no `learning_level` on explanation reflections. The level is chosen only in the chat.

### "Ik leg uit" feedback (2026-10-15)
- `POST /api/explain/evaluate` (`server/explain/routes.js`) assesses, scores and saves in one step; the browser only sends the explanation plus the course fragments it found. There is no browser-side save of feedback or score.
- The server always appends `explainFormatInstruction` (`server/explain/explainFeedback.js`) to the teacher's explain prompt. The prompt sets the tone; the block fixes the structure:
  - `### FEEDBACK`: only about THIS concept and its definition. A related concept is never a shortcoming.
  - `### SCORE`: 0–100 on a fixed scale. Start at 100. A reasonably good explanation is 70–90, a good one is 100.
  - `### RELATED`: at most 3 concepts, only from approved course concepts that share evidence fragments (`rankRelatedConcepts`). They do not count towards the score.
  - `### FEEDFORWARD`: 1–2 next steps.
- Stored as `student_explanations.feedback = { content, sections }` and `score = { total, reason }`. The score is shown only to the student, not in progress or analytics (decision 2026-10-15).
- `concepts.key_points` contains technical labels (`course_id:…`, `[RAG-…]`) and no real key points. Always filter them out (`cleanKeyPoints` in `server/explain/explainFeedback.js` / `realKeyPoints` in `server/rag/queryExpansion.js` and `src/services/queryExpansion.ts`) before they reach a prompt or a search query.
- Calibration against the real model (prospective cohort study): excellent 100, reasonable 85, confused 40, wrong 30. Re-check with a live run after changing the scale.

### "Verbeter deze uitleg" (2026-10-20)
- A second way of practising inside Ik leg uit (`server/explain/flawedExplanations.js`, `src/components/explain/ImproveExplanation.tsx`). The exercise is created ON THE SPOT, never stored and never reviewed by a person (decided by the user: no teacher or human check of errors, no collection of misconceptions). One call writes a correct explanation from the concept's course fragments (`concept_evidence` first, then search) and a version with K = 1..3 substantial errors from a fixed, subject-neutral list of error types; the student does not know K. A BLIND verification call must find exactly the intended errors, all substantial, with no extra substantial errors; otherwise retry (max 3), then a polite "not possible for this concept". Internal contradiction is deliberately NOT a rejection reason (it rejected far too many). Concepts with fewer than 2 fragments get no exercise.
- The correct version and the error list travel only as an AES-GCM sealed token (key from `TURN_SECRET`, `server/lib/turnSigning.js`), bound to the user, valid 3 h; the browser cannot read them. Routes: `/api/explain/improve/create`, `/evaluate` (blocks FOUND n/m, REASONING, WRONGLY_FLAGGED, NEXT_STEP; missed errors are never named in the feedback; reveal comes after), `/reflect` (journal only on request and only when the journal is on). Disclaimer + "Klopt dit wel?" (Studiecafé) are the safety net. Daily limit 40 per student (process memory).
- Course switches: `explainSelf` and `explainImprove` (`EXPLAIN_PARTS` in `server/courses/courseFeatures.js` and `src/lib/courseFeatures.ts`), default on, only valid while `explain` is on; at least one stays on (server 400 `explainNeedsOnePart`). Nothing new is written by the browser, so no DB policy change.
- Measure with `node --env-file=.env scripts/eval-flawed-explanations.mjs [n] [dir]` (same module, independent judge; target ≥90% of accepted exercises "good") and `scripts/eval-flawed-feedback.mjs` (grading of four simulated answer types). `server/__tests__/flawedExplanations.test.js` guards the rules.

Concept order and grouping per unit in Ik leg uit: see `docs/decisions/cursusmateriaal-en-rag.md`.

## Quiz

### Grounding and the teacher's source mix
- The LLM must not drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact; do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.
- Always validate quiz generation against actual course material and RAG evidence (see `docs/decisions/cursusmateriaal-en-rag.md`).
- Quiz prompts are out of scope of the prompt templates (left as they are; see `docs/decisions/leren-met-ai.md`).

### Student-facing learning loop
- "Your progress" on the quiz page (`src/lib/conceptProgress.ts`, client only, the student's own attempts) does spaced repetition: weak first, then due, then new.
  - The default difficulty follows the learning level.
  - `/quiz?concept=<id>&name=<name>` preselects a concept; Explain links to it.
- The quiz topic list shows concepts in course order (see `docs/decisions/cursusmateriaal-en-rag.md`).

### Data integrity
- Quiz attempts are written by the browser and guarded by the database (rescoring trigger, no updates afterwards): see `docs/decisions/privacy-en-data.md`. Never add a browser-side `.update()` on `quiz_attempts`.
- Teacher analytics on quiz attempts are aggregates with k ≥ 5: see `docs/decisions/privacy-en-data.md`.

## Formulas (2026-10-22)

- TeX typed by students is ALWAYS rendered, everywhere their text is shown: `MathText` (`src/components/MathText.tsx`, only formulas, the rest stays plain text) for chat bubbles, quiz answers, project group chat and persona chat; `MarkdownMessage` (`src/components/MarkdownMessage.tsx`) elsewhere. Delimiters: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`. Single dollars follow the Pandoc rule (`splitMath` in `src/lib/mathText.ts`), and `guardCurrencyDollars` keeps "$10 en $20" out of math in MarkdownMessage. KaTeX with `trust: false` (no links).
- The visual editor is OPT-IN per course (`formulaEditor` in `OPT_IN_FEATURES`, Onderdelen): a ∑ button (`FormulaButton`, `src/components/formula/`) next to every student text field (chat, Ik leg uit in both modes, quiz open/casus answers, Studiecafé new thread and reply, journal note, project group chat, persona chat, final reflection). The dialog (`FormulaDialog`) uses MathLive 0.111.0, lazy-loaded on the first click; fonts come from the self-hosted katex.min.css (`fontsDirectory`/`soundsDirectory` = null). Set MathLive options as attributes BEFORE mounting, otherwise "Mathfield not mounted". It inserts `$latex$` at the cursor; with the cursor inside a formula it opens that formula for editing. The old Studiecafé toolbar (FormulaEditor) is gone. Tests: `src/lib/__tests__/mathText.test.tsx`.
- Formulas are rendered by KaTeX in its own fonts (the UI font is Nunito, see `docs/decisions/techniek-en-werkwijze.md`).

## Learning journal and achievements

### Learning journal
- Automatic journal entries (reflections) are stored in three blocks: summary, feedback (went well / to improve) and next steps, in `learning_journal_entries.sections`, plus `learning_level` (the student's level at that moment, where applicable). New generators append `journalFormatInstruction(lang)` to the prompt and save `...journalFieldsFromModel(text, lang)` (`server/journal/journalSections.js`); `content` always stays filled as readable text. The model uses fixed `### SUMMARY` etc. headings, not JSON, so LaTeX survives.
- Project texts (interim checkpoint, final reflection, overview across conversations, summary per persona conversation, evaluator feedback rounds, "Beoordeling opvragen") use the same blocks. Structured input is converted without an extra LLM call (`server/projects/projectJournal.js`); free text is generated in blocks directly.
- The project never writes to the journals of all group members; members save to their OWN journal on request (2026-10-27): see `docs/decisions/projecten.md`.
- Every server write to `learning_journal_entries` must first check the journal switch (see `docs/decisions/cursusmateriaal-en-rag.md`); students cannot update journal entries and the browser never calls `.update()` on them (see `docs/decisions/privacy-en-data.md`).
- Chat reflections ("Opslaan in leerdagboek"): see `docs/decisions/leren-met-ai.md`.
- No `learning_level` on explanation reflections (see `docs/decisions/leren-met-ai.md`).

### Achievements
- Earned, never clicked: choosing a higher level in `LearningLevelSelector` has no celebration. The celebration (`LevelUpCelebration`) plus an achievement only follow a positive, server-validated verdict on "Ready for a higher level?" in the chat (`readinessCheck: true` → `server/chat/readiness.js`). The tutor appends an invisible `[[LEAP_READINESS …]]` label that the server always strips. The server decides eligibility itself: level from the DB, a minimum amount of student input (only server-signed turns count, see `docs/decisions/privacy-en-data.md`), and the topic must be an approved course concept.
- Achievements live in `student_achievements` (written only by the server; students read their own rows via RLS), are unique per (user, course, kind, topic_key, level), and point to a journal entry as evidence. Future kinds (quiz, project badges, learning goals) reuse this table.

## Subject-neutral texts and tutor instructions (2026-10-15)

- LEAP is not tied to one subject. UI texts and the fixed LLM instructions in code contain no subject content (no epidemiology or statistics examples); use neutral examples or examples from several fields. `server/__tests__/subjectNeutral.test.js` enforces this.
- The general chat and explain instructions in the DB are TEMPLATES (Sjabloon chat-instructie / Sjabloon Ik leg uit): the fallback for courses without their own instruction. Subject content belongs in the per-course instruction. E&B1 has its own copy of the old E&B text.
- Tutor-instructies (menu name since 2026-10-26; was Chat-instructies) (2026-10-20, `CoursePromptsPanel`, `server/prompts/promptTemplates.js`): per part (chat, explain) the teacher writes an own instruction for the active course. The field starts EMPTY and the template is never put into it; while it is empty a warning says students get the template. "Toon sjabloon" shows the template read-only with a copy button. Only the admin changes a template, and only after "Pas sjabloon aan", via `PUT /api/admin/prompt-templates/:section` (previous text logged in `leap_setting_changes`); the browser never writes templates to `chatbot_prompts`. Quiz prompts are out of scope (left as they are). `server/__tests__/promptTemplates.test.js` guards this.
- Prompts sent to the language model are not UI text; they are not translated (see `docs/decisions/techniek-en-werkwijze.md`).

## Design assistant ("Ontwerphulp")

- This is an optional chatbot for teachers in Beheer: a side panel (`DesignAssistantDock`, `src/components/admin/DesignAssistant.tsx`) opened from a tab on the right edge, available in every Beheer section and kept open while switching sections. It knows where the teacher is (`describePlace`). It is an experiment since 2026-10-07. The rollback point is git tag `pre-ontwerphulp-2026-10-07`, and the admin can switch it off via the gear in the panel.
- It must keep up with the engine. Its knowledge of LEAP is NEVER hand-written in the prompt; it is assembled per question in `server/system/designAssistant.js` from:
  - `ADMIN_SECTIONS` (tabs + who may use them);
  - the help texts (`help.*` in nl.json), and the student help texts (`OTHER_PAGES`, group `student`);
  - the fixed knowledge documents `KNOWLEDGE_DOCS`, always read in full (no retrieval step): the manual (`docs/handleiding/handleiding.html`) and the project step-by-step plan (`docs/handleiding/Stappenplan-project-LEAP.docx`, read straight from Word via `docxToText`, so edits in Word count). Both are copied into the Docker image; each must stay under `KNOWLEDGE_DOC_LIMIT` (a test fails otherwise, so nothing is cut silently);
  - the course state, fetched through the existing admin routes with the teacher's token.
- Its knowledge is 100% separate from course material (decided 2026-10-16): files in the repo only, never `documents`/`document_chunks`, nothing else in LEAP reads it, and teachers cannot change it. No external sources (no vu.nl pages). The didactic way of working lives in `DEFAULT_DESIGN_ASSISTANT_PROMPT`: constructive alignment, scaffolding, activating and blended education, varied assessment (LEAP activities are formative practice spaces, never a grade source), with the VU values open, personal and responsible in the background. It does not invent VU/faculty rules and refers to the programme and the VU Centre for Teaching & Learning.
- When you add, remove or re-permission an admin tab, or add a new help-text group, update `ADMIN_SECTIONS`. `server/__tests__/designAssistant.test.js` fails until you do.
- Only the admin can change the bot's way of working (prompt) and the on/off switch (chatbot_prompts rows `__design_assistant_prompt__` / `__design_assistant_enabled__`). The bot never changes anything itself; it gives advice and drafts.
