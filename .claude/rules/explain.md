---
paths:
  - "server/explain/**"
  - "src/pages/ExplainPage.tsx"
  - "src/components/explain/**"
  - "src/services/improveExplanation.service.ts"
  - "src/lib/explainFeedbackExcerpt.ts"
  - "scripts/eval-flawed-*.mjs"
---

# "Ik leg uit" (explain) and "Verbeter deze uitleg"

## No learning levels here (decided 2026-10-15)
- Learning levels play no role in "Ik leg uit": you master a concept or you do not. There is no selector, no level in the assessment, and no `learning_level` on explanation reflections. The level is chosen only in the chat.

## "Ik leg uit" feedback (2026-10-15)
- `POST /api/explain/evaluate` (`server/explain/routes.js`) assesses, scores and saves in one step; the browser only sends the explanation plus the course fragments it found. There is no browser-side save of feedback or score.
- The server always appends `explainFormatInstruction` (`server/explain/explainFeedback.js`) to the teacher's explain prompt. The prompt sets the tone; the block fixes the structure:
  - `### FEEDBACK`: only about THIS concept and its definition. A related concept is never a shortcoming.
  - `### SCORE`: 0–100 on a fixed scale. Start at 100. A reasonably good explanation is 70–90, a good one is 100.
  - `### RELATED`: at most 3 concepts, only from approved course concepts that share evidence fragments (`rankRelatedConcepts`). They do not count towards the score.
  - `### FEEDFORWARD`: 1–2 next steps.
- Stored as `student_explanations.feedback = { content, sections }` and `score = { total, reason }`. The score is shown only to the student, not in progress or analytics (decision 2026-10-15).
- `concepts.key_points` contains technical labels (`course_id:…`, `[RAG-…]`) and no real key points. Always filter them out (`cleanKeyPoints` in `server/explain/explainFeedback.js` / `realKeyPoints` in `server/rag/queryExpansion.js` and `src/services/queryExpansion.ts`) before they reach a prompt or a search query.
- Calibration against the real model (prospective cohort study): excellent 100, reasonable 85, confused 40, wrong 30. Re-check with a live run after changing the scale.

## "Verbeter deze uitleg" (2026-10-20)
- A second way of practising inside Ik leg uit (`server/explain/flawedExplanations.js`, `src/components/explain/ImproveExplanation.tsx`). The exercise is created ON THE SPOT, never stored and never reviewed by a person (decided by the user: no teacher or human check of errors, no collection of misconceptions). One call writes a correct explanation from the concept's course fragments (`concept_evidence` first, then search) and a version with K = 1..3 substantial errors from a fixed, subject-neutral list of error types; the student does not know K. A BLIND verification call must find exactly the intended errors, all substantial, with no extra substantial errors; otherwise retry (max 3), then a polite "not possible for this concept". Internal contradiction is deliberately NOT a rejection reason (it rejected far too many). Concepts with fewer than 2 fragments get no exercise.
- The correct version and the error list travel only as an AES-GCM sealed token (key from `TURN_SECRET`, `server/lib/turnSigning.js`), bound to the user, valid 3 h; the browser cannot read them. Routes: `/api/explain/improve/create`, `/evaluate` (blocks FOUND n/m, REASONING, WRONGLY_FLAGGED, NEXT_STEP; missed errors are never named in the feedback; reveal comes after), `/reflect` (journal only on request and only when the journal is on). Disclaimer + "Klopt dit wel?" (Studiecafé) are the safety net. Daily limit 40 per student (process memory).
- Course switches: `explainSelf` and `explainImprove` (`EXPLAIN_PARTS` in `server/courses/courseFeatures.js` and `src/lib/courseFeatures.ts`), default on, only valid while `explain` is on; at least one stays on (server 400 `explainNeedsOnePart`). Nothing new is written by the browser, so no DB policy change.
- Measure with `node --env-file=.env scripts/eval-flawed-explanations.mjs [n] [dir]` (same module, independent judge; target ≥90% of accepted exercises "good") and `scripts/eval-flawed-feedback.mjs` (grading of four simulated answer types). `server/__tests__/flawedExplanations.test.js` guards the rules.

Concept order and grouping per unit in Ik leg uit: see `course-structure.md`.
