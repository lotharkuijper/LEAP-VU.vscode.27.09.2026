---
paths:
  - "server/rag/**"
  - "server/ingestion/**"
  - "server/concepts/**"
  - "server/documents/**"
  - "server/courses/courseOverview.js"
  - "src/services/{rag,concept-extraction,document-processor,document-upload,web-import,course-files,folder,quiz-context}.service.ts"
  - "src/services/queryExpansion.ts"
  - "src/lib/conceptExtractionJob.ts"
  - "src/components/concepts/**"
  - "src/components/material/**"
  - "src/components/{ConceptQualityPanel,ConceptReviewPanel,DocumentManagement,DocumentRetryPanel,DocumentViewer,RAGDiagnostics,RAGDocumentStatusPanel,RAGStatusIndicator,WebImportPanel,ExtractionProgressText}.tsx"
---

# RAG, ingestion and concept extraction

LEAP is built around course document ingestion, RAG chunking, concept extraction, quiz generation and teacher-scoped source validation. Everything here serves one rule: answers, questions and concepts come from the course material, not from model creativity.

## Evidence and source mix
- The LLM must not drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact.
- Question generation and concept extraction must be checked against real document chunks and embeddings, not just model creativity.
- Do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.
- Do not silently accept a "no result" state when document ingestion is broken.
- Do not assume Supabase or Azure config is correct without checking the live runtime config and DB records.

## Concept extraction
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
- `concepts.key_points` contains technical labels (`course_id:…`, `[RAG-…]`); filter them out (`cleanKeyPoints` / `realKeyPoints`) before they reach a prompt or a search query (see `explain.md`).

## Ingestion and chunking
- Uploads are read in through one queue (`server/ingestion/processingQueue.js`, 2 at a time; rate limits are re-queued, not failed). Count chunks in the database (GROUP BY), never by fetching chunk rows in the browser: the API returns at most 1000 rows.
- A document that collapses into a single giant chunk is a failure mode and must be diagnosed.
- Office files should be converted to readable plain text; never write `[object Object]` into stored chunks.
- For ingestion and chunking fixes, add a reproduction/regression test.

## Search
- Searching across languages (`server/rag/crossLingual.js`, `POST /api/rag/query-variants`): when the question's language differs from the course material's majority language, the server translates the question and `searchRelevantChunksWithStats` (`src/services/rag.service.ts`) searches with both, keeping the best score per passage. Never blocking: on any failure it searches with the original question only.
- The tutor chat always gets a short course overview (`server/courses/courseOverview.js`: name, description, leerlijn units or material titles, approved concepts) for orientation questions; it is explicitly not a source for content explanations.

## Verify
- `npx vitest run server/__tests__/ragProcessing.test.js`
- `npx vitest run server/__tests__/conceptExtraction.test.js server/__tests__/conceptConsolidation.test.js`
- `node --env-file=.env scripts/check-document-viewer.mjs`: document viewer in a real browser (text layer for selecting and copying, zoom, full screen via the Fullscreen API, "Vraag in de chat").
