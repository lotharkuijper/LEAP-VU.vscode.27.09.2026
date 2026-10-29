---
paths:
  - "server/courses/courseUnits.js"
  - "server/concepts/conceptOrder.js"
  - "src/lib/conceptOrder.ts"
  - "src/hooks/{useLeerlijn,useConceptOrder}.ts"
  - "src/pages/{ExplainPage,QuizPage}.tsx"
  - "server/chat/routes.js"
  - "scripts/eval-leerlijn.mjs"
---

# Leerlijn (learning path) and concept order

## Learning path / leerlijn (2026-10-16)
- Teachers can order course material into units (Beheer → Cursusmateriaal → Bestanden → Leerlijn): `course_units` (position; EQUAL position = side by side) and `course_unit_documents` (per course). NO dates: it is the build-up of the material, not a schedule (students outside the course period and externals). Proposal from file numbering (`proposeUnits`). Code: `server/courses/courseUnits.js`, migration `20261016130000_course_units` (+ rollback).
- Tutor chat: the question sets the anchor (unit with most similarity among the sources, or the student's own choice "Ik werk aan …", stored only in the browser). The leerlijn block (before the language/level block) labels units earlier / anchor / parallel / later; the tutor builds on earlier units and refers ahead sparingly, EXCEPT to units the student already practised (own quiz attempts, explanations and chat sources, `practiceByUnit`, threshold 2). Retrieval is never restricted.
- Re-check with `node --env-file=.env scripts/eval-leerlijn.mjs` (real model, no writes): later-unit terms must drop with the leerlijn (B < A) and come back when that unit was practised (C > B).

## Concept order (2026-10-24)
- `server/concepts/conceptOrder.js`, `GET /api/concepts/order`, cached 5 min per course: every concept gets the place where it FIRST occurs in the material (leerlijn unit position → file numbering within the unit → chunk_index of the first evidence fragment; without a leerlijn the file numbering via `proposeUnits`; unnumbered/unassigned files go last; no evidence → `source_document_ids`, else "place unknown").
- Ik leg uit and the quiz topic list show concepts in that order, grouped per unit in Ik leg uit, with a dot in ONE hue (brand 300 → 950, light = start, dark = end; `src/lib/conceptOrder.ts`) plus the meaning in words (tooltip/aria) and a legend.
- Nothing is hidden or locked (decision 2026-10-24: students may already know later concepts). "Aanbevolen om mee te beginnen" = the first concepts in course order not yet explained; "Jouw voortgang" breaks ties (e.g. among new concepts) by course order. The chat is deliberately not involved.
