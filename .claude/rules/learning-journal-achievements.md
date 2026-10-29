---
paths:
  - "server/journal/**"
  - "server/chat/readiness.js"
  - "server/projects/projectJournal*.js"
  - "src/pages/FeedbackPage.tsx"
  - "src/components/{JournalSections,AchievementsView,LevelUpCelebration,LearningLevelSelector}.tsx"
  - "src/hooks/useLearningLevel.ts"
  - "src/lib/readiness.ts"
---

# Learning journal and achievements

## Learning journal
- Automatic journal entries (reflections) are stored in three blocks: summary, feedback (went well / to improve) and next steps, in `learning_journal_entries.sections`, plus `learning_level` (the student's level at that moment, where applicable). New generators append `journalFormatInstruction(lang)` to the prompt and save `...journalFieldsFromModel(text, lang)` (`server/journal/journalSections.js`); `content` always stays filled as readable text. The model uses fixed `### SUMMARY` etc. headings, not JSON, so LaTeX survives.
- Project texts (interim checkpoint, final reflection, overview across conversations, summary per persona conversation, evaluator feedback rounds, "Beoordeling opvragen") use the same blocks. Structured input is converted without an extra LLM call (`server/projects/projectJournal.js`); free text is generated in blocks directly.
- The project never writes to the journals of all group members; members save to their OWN journal on request (2026-10-27): see `projects-personas.md`.
- Every server write to `learning_journal_entries` must first check the journal switch (see `course-features.md`); students cannot update journal entries and the browser never calls `.update()` on them (see `privacy-and-integrity.md`).
- Chat reflections ("Opslaan in leerdagboek"): see `chat-tutor.md`.
- No `learning_level` on explanation reflections (see `explain.md`).

## Achievements
- Earned, never clicked: choosing a higher level in `LearningLevelSelector` has no celebration. The celebration (`LevelUpCelebration`) plus an achievement only follow a positive, server-validated verdict on "Ready for a higher level?" in the chat (`readinessCheck: true` → `server/chat/readiness.js`). The tutor appends an invisible `[[LEAP_READINESS …]]` label that the server always strips. The server decides eligibility itself: level from the DB, a minimum amount of student input (only server-signed turns count, see `privacy-and-integrity.md`), and the topic must be an approved course concept.
- Achievements live in `student_achievements` (written only by the server; students read their own rows via RLS), are unique per (user, course, kind, topic_key, level), and point to a journal entry as evidence. Future kinds (quiz, project badges, learning goals) reuse this table.
