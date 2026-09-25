# LEAP-VU project instructions for Claude-style assistants

## Project overview
- This repository is the LEAP-VU learning platform.
- Stack: React + TypeScript + Vite frontend, Node/Express server, Supabase, Azure OpenAI, Postgres.
- The system is built around course document ingestion, RAG chunking, concept extraction, quiz generation, and teacher-scoped source validation.

## Core principles
- Prefer grounded answers over creative generation.
- Always validate quiz generation, teaching content, and concept extraction against actual course material and RAG evidence.
- Do not silently accept a "no result" state when document ingestion is broken.
- When a bug is found, fix the root cause and add a regression test.

## High-priority constraints
- The LLM should not be allowed to drift into LLM-only quiz generation when course-source evidence is weak.
- Teacher-controlled source mixing must remain intact.
- Question generation and concept extraction must be checked against real document chunks and embeddings, not just model creativity.
- Do not down-rank evidence quality by changing the source mix in a way that hides missing ingestion problems.

## RAG and ingestion rules
- Verify chunking before concept extraction.
- A document that collapses into a single giant chunk is a failure mode and must be diagnosed.
- Office files should be converted to readable plain text; never write `[object Object]` into stored chunks.
- Do not assume Supabase or Azure config is correct without checking the live runtime config and DB records.

## Testing expectations
- Prefer real behavior tests over mock-only assertions.
- For ingestion and chunking fixes, add a reproduction/regression test.
- Before claiming success, run the smallest relevant test suite.

## Common verification commands
- `npx vitest run server/__tests__/ragProcessing.test.js`
- `npx vitest run server/__tests__/conceptExtraction.test.js`
- `npm run dev`

## Code quality expectations
- Keep fixes minimal and targeted.
- Preserve existing server/frontend architecture unless required by the bug.
- Record the root cause and the verification evidence in the change notes or in the conversation.

## Sensitive notes
- Do not put secrets in the repo.
- Trust `.env` values only when they are actually loaded and resolved in the runtime environment.
- For Azure calls, use the configured deployment names and API version; do not silently fallback to public OpenAI for embeddings.
