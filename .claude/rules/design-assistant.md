---
paths:
  - "server/system/designAssistant.js"
  - "src/components/admin/DesignAssistant.tsx"
  - "src/pages/AdminPage.tsx"
  - "src/help/**"
  - "src/i18n/locales/nl.json"
  - "docs/handleiding/**"
---

# Design assistant ("Ontwerphulp")

- This is an optional chatbot for teachers in Beheer: a side panel (`DesignAssistantDock`, `src/components/admin/DesignAssistant.tsx`) opened from a tab on the right edge, available in every Beheer section and kept open while switching sections. It knows where the teacher is (`describePlace`). It is an experiment since 2026-10-07. The rollback point is git tag `pre-ontwerphulp-2026-10-07`, and the admin can switch it off via the gear in the panel.
- It must keep up with the engine. Its knowledge of LEAP is NEVER hand-written in the prompt; it is assembled per question in `server/system/designAssistant.js` from:
  - `ADMIN_SECTIONS` (tabs + who may use them);
  - the help texts (`help.*` in nl.json), and the student help texts (`OTHER_PAGES`, group `student`);
  - the fixed knowledge documents `KNOWLEDGE_DOCS`, always read in full (no retrieval step): the manual (`docs/handleiding/handleiding.html`) and the project step-by-step plan (`docs/handleiding/Stappenplan-project-LEAP.docx`, read straight from Word via `docxToText`, so edits in Word count). Both are copied into the Docker image; each must stay under `KNOWLEDGE_DOC_LIMIT` (a test fails otherwise, so nothing is cut silently);
  - the course state, fetched through the existing admin routes with the teacher's token.
- Its knowledge is 100% separate from course material (decided 2026-10-16): files in the repo only, never `documents`/`document_chunks`, nothing else in LEAP reads it, and teachers cannot change it. No external sources (no vu.nl pages). The didactic way of working lives in `DEFAULT_DESIGN_ASSISTANT_PROMPT`: constructive alignment, scaffolding, activating and blended education, varied assessment (LEAP activities are formative practice spaces, never a grade source), with the VU values open, personal and responsible in the background. It does not invent VU/faculty rules and refers to the programme and the VU Centre for Teaching & Learning.
- When you add, remove or re-permission an admin tab, or add a new help-text group, update `ADMIN_SECTIONS`. `server/__tests__/designAssistant.test.js` fails until you do.
- Only the admin can change the bot's way of working (prompt) and the on/off switch (chatbot_prompts rows `__design_assistant_prompt__` / `__design_assistant_enabled__`). The bot never changes anything itself; it gives advice and drafts.
