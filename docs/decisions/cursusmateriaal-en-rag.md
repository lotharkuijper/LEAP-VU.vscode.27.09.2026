# Cursusmateriaal, RAG en begrippen

Besluiten en werking van LEAP op dit gebied, zoals ze in de oude CLAUDE.md stonden. Geen instructies die altijd gelden, maar naslag: lees dit als je aan dit onderdeel werkt, en werk het bij als een besluit verandert.

## RAG, ingestion and concept extraction

LEAP is built around course document ingestion, RAG chunking, concept extraction, quiz generation and teacher-scoped source validation. Everything here serves one rule: answers, questions and concepts come from the course material, not from model creativity.

### Evidence and source mix
- The LLM must not drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact.
- Question generation and concept extraction must be checked against real document chunks and embeddings, not just model creativity.
- Do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.
- Do not silently accept a "no result" state when document ingestion is broken.
- Do not assume Supabase or Azure config is correct without checking the live runtime config and DB records.

### Concept extraction
- Concept extraction reads the WHOLE course: all chunks per document, in windows of ~12k characters (`server/concepts/conceptConsolidation.js`), one LLM call per window, and every candidate keeps its `source_document_ids`. Never go back to a single sample of chunks (it used to cover 5% of E&B1).
- Duplicates are handled in three ways:
  - Sure cases are merged automatically (`planSureMerges`): spelling variants (`conceptKey`), and a concept whose name is stored as an alias of another concept. An extraction candidate that matches an existing alias is never inserted as a new concept.
  - Synonyms, abbreviations and translations go through the LLM synonym step (narrow, automatic); the other names are stored as `aliases`.
  - Doubtful cases are shown to the teacher as suggestions (`/api/admin/concepts/merge-suggestions` in `server/concepts/routes.js`, broad prompt `buildDuplicateSuggestionPrompt`, including variants with a qualifier). Every concept should appear only once: a module concept that also exists as a course concept is listed first (`kind: 'crossClass'`), and the course concept is kept.
- Merging always goes through the DB function `merge_concepts`, which moves all references along.
- Minimum and maximum number of concepts are set per course on the Concepts step (`extraction.min_concepts` / `max_concepts`). Selection is `selectConcepts` (`server/concepts/conceptConsolidation.js`): one by one, highest match (RAG score on a fixed 0.40–0.90 scale, evidence count, multi-document core term) minus overlap (cosine to already chosen), with a small bonus for an unrepresented document. Below the minimum, top up only from candidates WITH evidence (≥1 chunk) under the evidence threshold, stored as `needs_review`; never without evidence. A shortfall is reported, not padded.
- The frontend runs extraction as a background job (`runConceptExtraction` in `src/lib/conceptExtractionJob.ts`; job state `conceptJobs` in `server/concepts/routes.js`), because a request of several minutes gets cut off by proxies. Every window retries rate limits, 5xx and network errors (ECONNRESET) and never throws; windows that still fail are named in the result message, never dropped silently (Microbiologie, 534 windows, 2026-10-18).
- Verify chunking before concept extraction.
- Concepts never leak between courses: `/api/concepts` returns only the course's own concepts (no fallback to concepts without a course; without a course only the manage view sees everything). Query expansion (`server/rag/queryExpansion.js`, `src/services/queryExpansion.ts`) uses only the concept's own aliases, key points and definition, with no static synonym list.
- `concepts.key_points` contains technical labels (`course_id:…`, `[RAG-…]`); filter them out (`cleanKeyPoints` / `realKeyPoints`) before they reach a prompt or a search query (see `docs/decisions/leren-met-ai.md`).

### Ingestion and chunking
- Uploads are read in through one queue (`server/ingestion/processingQueue.js`, 2 at a time; rate limits are re-queued, not failed). Count chunks in the database (GROUP BY), never by fetching chunk rows in the browser: the API returns at most 1000 rows.
- A document that collapses into a single giant chunk is a failure mode and must be diagnosed.
- Office files should be converted to readable plain text; never write `[object Object]` into stored chunks.
- For ingestion and chunking fixes, add a reproduction/regression test.

### Search
- Searching across languages (`server/rag/crossLingual.js`, `POST /api/rag/query-variants`): when the question's language differs from the course material's majority language, the server translates the question and `searchRelevantChunksWithStats` (`src/services/rag.service.ts`) searches with both, keeping the best score per passage. Never blocking: on any failure it searches with the original question only.
- The tutor chat always gets a short course overview (`server/courses/courseOverview.js`: name, description, leerlijn units or material titles, approved concepts) for orientation questions; it is explicitly not a source for content explanations.

### Verify
- `npx vitest run server/__tests__/ragProcessing.test.js`
- `npx vitest run server/__tests__/conceptExtraction.test.js server/__tests__/conceptConsolidation.test.js`
- `node --env-file=.env scripts/check-document-viewer.mjs`: document viewer in a real browser (text layer for selecting and copying, zoom, full screen via the Fullscreen API, "Vraag in de chat").

## Leerlijn (learning path) and concept order

### Learning path / leerlijn (2026-10-16)
- Teachers can order course material into units (Beheer → Cursusmateriaal → Bestanden → Leerlijn): `course_units` (position; EQUAL position = side by side) and `course_unit_documents` (per course). NO dates: it is the build-up of the material, not a schedule (students outside the course period and externals). Proposal from file numbering (`proposeUnits`). Code: `server/courses/courseUnits.js`, migration `20261016130000_course_units` (+ rollback).
- Tutor chat: the question sets the anchor (unit with most similarity among the sources, or the student's own choice "Ik werk aan …", stored only in the browser). The leerlijn block (before the language/level block) labels units earlier / anchor / parallel / later; the tutor builds on earlier units and refers ahead sparingly, EXCEPT to units the student already practised (own quiz attempts, explanations and chat sources, `practiceByUnit`, threshold 2). Retrieval is never restricted.
- Re-check with `node --env-file=.env scripts/eval-leerlijn.mjs` (real model, no writes): later-unit terms must drop with the leerlijn (B < A) and come back when that unit was practised (C > B).

### Concept order (2026-10-24)
- `server/concepts/conceptOrder.js`, `GET /api/concepts/order`, cached 5 min per course: every concept gets the place where it FIRST occurs in the material (leerlijn unit position → file numbering within the unit → chunk_index of the first evidence fragment; without a leerlijn the file numbering via `proposeUnits`; unnumbered/unassigned files go last; no evidence → `source_document_ids`, else "place unknown").
- Ik leg uit and the quiz topic list show concepts in that order, grouped per unit in Ik leg uit, with a dot in ONE hue (brand 300 → 950, light = start, dark = end; `src/lib/conceptOrder.ts`) plus the meaning in words (tooltip/aria) and a legend.
- Nothing is hidden or locked (decision 2026-10-24: students may already know later concepts). "Aanbevolen om mee te beginnen" = the first concepts in course order not yet explained; "Jouw voortgang" breaks ties (e.g. among new concepts) by course order. The chat is deliberately not involved.

## Course features on/off (2026-10-15)

- Teachers switch student parts per course in Beheer → Onderdelen aan/uit (`CourseFeaturesAdminTab`): chat, explain, quiz, projects, journal, studiecafe. `courses.features` stores only what is OFF (`{"quiz": false}`); a missing key means on. Switching off hides, it never deletes.
- One rule everywhere: `server/courses/courseFeatures.js` (server) and `src/lib/courseFeatures.ts` (browser, must stay identical; a test compares them). Course teachers and admins keep using a disabled part, labelled "uit voor studenten".
- Enforced in three layers:
  - browser: menu, dashboard tiles, `CourseFeatureGate` per page (in `ProtectedRoute`, `src/App.tsx`), and links between parts (`useCourseFeatures().visible(f)`);
  - server: `rejectIfFeatureOff` / `courseFeatureOnFor` (`server/lib/courseFeatureGate.js`). `/api/chat` serves chat, explain and quiz, so only the part named by `featureForChatRequest` is blocked;
  - database: `leap_course_feature_on` in the insert policies of conversations, quiz_attempts and learning_journal_entries (migration `20261015100000_course_features`, rollback in `supabase/rollback/`).
- Every server write to `learning_journal_entries` must first check the journal switch; `server/__tests__/courseFeatures.test.js` fails otherwise. Evaluator reports ("Beoordeling opvragen") are stored in `project_group_assessments` and shown in the project room; a member can save them to their own journal only when it is on.
- OPT-IN features (`OPT_IN_FEATURES`; on only with an explicit `true`): `attachments` (see `docs/decisions/leren-met-ai.md`) and `formulaEditor` (see `docs/decisions/leren-met-ai.md`).
- Sub-switches of explain: `explainSelf` / `explainImprove` (`EXPLAIN_PARTS`; see `docs/decisions/leren-met-ai.md`).
