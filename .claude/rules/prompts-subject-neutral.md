---
paths:
  - "server/prompts/**"
  - "src/components/CoursePromptsPanel.tsx"
  - "server/chat/**"
  - "server/explain/**"
  - "server/projects/*Review*.js"
  - "server/projects/preassessment.js"
  - "server/__tests__/subjectNeutral.test.js"
---

# Subject-neutral texts and tutor instructions (2026-10-15)

- LEAP is not tied to one subject. UI texts and the fixed LLM instructions in code contain no subject content (no epidemiology or statistics examples); use neutral examples or examples from several fields. `server/__tests__/subjectNeutral.test.js` enforces this.
- The general chat and explain instructions in the DB are TEMPLATES (Sjabloon chat-instructie / Sjabloon Ik leg uit): the fallback for courses without their own instruction. Subject content belongs in the per-course instruction. E&B1 has its own copy of the old E&B text.
- Tutor-instructies (menu name since 2026-10-26; was Chat-instructies) (2026-10-20, `CoursePromptsPanel`, `server/prompts/promptTemplates.js`): per part (chat, explain) the teacher writes an own instruction for the active course. The field starts EMPTY and the template is never put into it; while it is empty a warning says students get the template. "Toon sjabloon" shows the template read-only with a copy button. Only the admin changes a template, and only after "Pas sjabloon aan", via `PUT /api/admin/prompt-templates/:section` (previous text logged in `leap_setting_changes`); the browser never writes templates to `chatbot_prompts`. Quiz prompts are out of scope (left as they are). `server/__tests__/promptTemplates.test.js` guards this.
- Prompts sent to the language model are not UI text; they are not translated (see `i18n.md`).
