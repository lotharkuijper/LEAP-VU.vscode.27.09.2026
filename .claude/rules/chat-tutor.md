---
paths:
  - "server/chat/**"
  - "server/courses/courseOverview.js"
  - "src/pages/ChatPage.tsx"
  - "src/components/chat/**"
  - "src/services/llm.service.ts"
  - "src/hooks/{useChatAttachments,useLearningLevel}.ts"
  - "src/lib/{chatAttachments,chatQuote,readiness}.ts"
  - "src/components/LearningLevelSelector.tsx"
  - "src/pages/admin/{ChatAttachmentsPlatformPanel,CourseAttachmentsSetting}.tsx"
  - "scripts/eval-level-language.mjs"
  - "scripts/eval-chat-attachments.mjs"
  - "scripts/check-chat-attachments*.mjs"
---

# Tutor chat

Order of blocks in the tutor system prompt: the attachment block, the chat-goal block and the leerlijn block (see `course-structure.md`) all go BEFORE the language/level block.

The tutor chat always gets a short course overview (`server/courses/courseOverview.js`); it is for orientation questions, never a source for content explanations (see `rag-ingestion-concepts.md`).

## Learning level in the chat
- In the chat the level really changes the language. `server/chat/learningLevel.js` has a level table (`LEVEL_PROFILES`) with six dimensions: language (CEFR B1→C2), terminology, sentences, abstraction, prior knowledge and step size, plus the answer length. The teacher's chat prompt and the level complement each other; neither overrules the other. The teacher decides the KIND of response: role, approach (e.g. Socratic), structure, tone and limits such as a maximum length. The level decides HOW technical and complex the answer is within that frame: language, terminology, abstraction, prior knowledge and the difficulty of a question. Length sits at the short or long end of the teacher's limit. The teacher's approach is carried out AT the level; for example, "start from what the student knows" means everyday experience at level 1 and a deeper aspect at level 5. Teachers do not need to specify language level in their prompt (help text `chatInstructions.overview`). Check changes with `node --env-file=.env scripts/eval-level-language.mjs` (real model, test account): LIX must rise from level 1 to 5, level 1 has at most ~1 technical term, and level 5 is at least 10 LIX points above level 1.
- The level is chosen only in the chat. It plays no role in "Ik leg uit" (see `explain.md`) or in projects (see `projects-personas.md`).
- "Ready for a higher level?", achievements and turn signing: see `learning-journal-achievements.md` and `privacy-and-integrity.md`.

## Optional goal in the chat (2026-10-20)
- The student may set a goal for a chat conversation with the "Doel" button (`src/components/chat/ChatGoal.tsx`, `server/chat/chatGoal.js`). Never required, invisible to teachers, no analytics or achievements. It is sent as `chatGoal` with each tutor-chat request and becomes a block BEFORE the language/level block (treated as the student's wish, not an instruction; the teacher's approach stays leading). It is stored only as a label on the student's messages (`retrieved_context.chatGoal`, `null` = removed), restored when the conversation is reopened, and the journal reflection at closing says how far the student got (`lastChatGoal` / `chatGoalSummaryLine`). `server/__tests__/chatGoal.test.js`.

## Chat reflection in the journal (2026-10-27)
- Students can save a reflection on a chat conversation at any time with "Opslaan in leerdagboek" (`POST /api/chat/reflect`); the conversation stays so they can continue later. `createChatReflection` (`server/chat/routes.js`) is shared with delete-with-summary (`/api/chat/delete`): it checks the journal switch, reflects only on messages since the previous save of that conversation (`source_ref` `chat:<conversation>:<last message id>`, earlier part as context only, title "(deel n)"), and returns `nothingNew` instead of writing a duplicate. `server/__tests__/chatReflect.test.js`.

## Attachments in the chat (2026-10-16)
- Students can paste an image (Windows+Shift+S), pick one via the paperclip, drag one in, or add a file (PDF, DOCX, PPTX, ODT/ODP, TXT, MD) in the tutor chat. Plan and test results: `docs/plans/chat-bijlagen-plan.html`, `docs/plans/chat-bijlagen-fase0.md`.
- Two switches, both needed:
  - the admin's master switch (chatbot_prompts row `__chat_attachments__`, admin → Instellingen; OFF by default, the emergency brake for everyone; switching off keeps each course's choice);
  - the course switch `attachments`, an OPT-IN feature (`OPT_IN_FEATURES` in `server/courses/courseFeatures.js` and `src/lib/courseFeatures.ts`): on only with `{"attachments": true}`. Switching on needs the warning + second confirmation (`confirmAttachments: true`). Changes go to `leap_setting_changes`.
- NOTHING is stored. Attachments live in browser memory only (`useChatAttachments`) and are forgotten when the chat is closed. Messages store only a label (`retrieved_context.attachments`: kind, name, size, pages). The database rejects inline files (`data:…;base64,`) in `messages` and the Studiecafé tables (migration `20261016100000_chat_attachments`); `stashStudiecafeHandoff` (`src/lib/studiecafeHandoff.ts`) refuses them too. Never log attachment content.
- An image is sent to the model once (the tutor starts with "Dit zie ik:"); file text is sent with every turn (capped). The attachment block goes BEFORE the language/level block in the system prompt. A typed explanation is required with every attachment.
- Default detail level is HIGH: in the 16-10 test, low detail invented content on a full page of small text. Re-check with `node --env-file=.env scripts/eval-chat-attachments.mjs <dir>`, `scripts/check-chat-attachments.mjs` (API) and `scripts/check-chat-attachments-ui.mjs` (browser). The daily limit counter is held in process memory (single replica).
