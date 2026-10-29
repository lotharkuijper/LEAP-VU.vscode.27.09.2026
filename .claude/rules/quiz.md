---
paths:
  - "server/quiz/**"
  - "src/pages/QuizPage.tsx"
  - "src/pages/ShareStats*.tsx"
  - "src/components/quiz/**"
  - "src/components/{QuizSourcesAdminPanel,QuizCheckLLMButton,QuizGenerationProgress,ShareStatsImportPanel}.tsx"
  - "src/components/quizSourcesLogic.ts"
  - "src/services/quiz-*.service.ts"
  - "src/lib/{conceptProgress,quizFeedbackExcerpt,quizMappingsMerge,quizTimeEstimate}.ts"
---

# Quiz

## Grounding and the teacher's source mix
- The LLM must not drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact; do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.
- Always validate quiz generation against actual course material and RAG evidence (see `rag-ingestion-concepts.md`).
- Quiz prompts are out of scope of the prompt templates (left as they are; see `prompts-subject-neutral.md`).

## Student-facing learning loop
- "Your progress" on the quiz page (`src/lib/conceptProgress.ts`, client only, the student's own attempts) does spaced repetition: weak first, then due, then new.
  - The default difficulty follows the learning level.
  - `/quiz?concept=<id>&name=<name>` preselects a concept; Explain links to it.
- The quiz topic list shows concepts in course order (see `course-structure.md`).

## Data integrity
- Quiz attempts are written by the browser and guarded by the database (rescoring trigger, no updates afterwards): see `privacy-and-integrity.md`. Never add a browser-side `.update()` on `quiz_attempts`.
- Teacher analytics on quiz attempts are aggregates with k ≥ 5: see `analytics-and-token-budget.md`.
