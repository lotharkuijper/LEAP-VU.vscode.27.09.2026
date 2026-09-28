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
- Concept extraction reads the WHOLE course: all chunks per document, in windows of ~12k characters (`server/conceptConsolidation.js`), one LLM call per window, and every candidate keeps its `source_document_ids`. Never go back to a single sample of chunks (it used to cover 5% of E&B1).
- Duplicates are handled in three ways:
  - Sure spelling variants (`conceptKey`) are merged automatically.
  - Synonyms, abbreviations and translations go through the LLM synonym step; the other names are stored as `aliases`.
  - Doubtful cases are shown to the teacher as suggestions (`/api/admin/concepts/merge-suggestions`).
- Merging always goes through the DB function `merge_concepts`, which moves all references along.
- The frontend runs extraction as a background job (`runConceptExtraction`), because a request of several minutes gets cut off by proxies.
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

## Language and help texts
- No user-visible text may exist only in Dutch. Every UI string goes through i18n (`t('key')` in components, `tStatic(getActiveLang(), 'key')` elsewhere); `src/i18n/locales/nl.json` is the source of truth, `en.json` is maintained by hand, and the other languages are filled with `node --env-file=.env scripts/i18n-generate.mjs` (re-run until "RESTEREND totaal: 0"). The locale parity test must pass.
- Server messages shown to users (JSON `error`/`message`) are translated centrally by the response middleware in `server/serverI18n.js` using the language the client sends; add new messages to that dictionary (see the file header) instead of hard-coding per-language text.
- Prompts sent to the language model are not UI text and stay as they are.
- Help texts in the admin ("?" buttons, `src/components/help/HelpTip.tsx`) belong to a FUNCTION, not a place: ids live in `src/help/helpTopics.ts`, texts under `help.<id>.title/body`. When restructuring the admin, move the `<HelpTip>` with its control, update the text if the behaviour changed, and remove the id when a function disappears. `src/help/__tests__/helpTopics.test.ts` fails on unknown, unused or stray help ids.
- Icon-only buttons get `<Tooltip label={t(…)}>` (`src/components/help/Tooltip.tsx`: hover + keyboard focus, sets aria-label) instead of `title=`. Explanation text in the admin uses `<AdminHint variant="intro|tip|warning">` (`src/components/help/AdminHint.tsx`) instead of ad-hoc grey lines or blue boxes; `tip` and all HelpTips disappear when the teacher switches "Uitleg tonen" off (`HelpToggle`, `helpVisibility.ts`).
- Generic button/status words use `common.*` keys (e.g. `common.cancelAction`, `common.busy`), never a key borrowed from an unrelated feature namespace.

## Look and feel
- Colours come from the LEAP palette: CSS variables `--leap-brand-*`, `--leap-ink-*`, `--leap-accent-*` in `src/index.css`, wired up in `tailwind.config.js`. Use `brand-*` for the main colour, `ink-*` for neutrals and `accent-*` for successes/rewards. `blue`/`sky` map to brand and `gray`/`slate` to ink, so existing classes follow the palette. Never hard-code hex colours in components.
- Font: Nunito, self-hosted via `@fontsource-variable/nunito` (no Google Fonts link). Formulas are rendered by KaTeX in its own fonts.

## Learning journal
- Automatic journal entries (reflections) are stored in three blocks: summary, feedback (went well / to improve) and next steps, in `learning_journal_entries.sections`, plus `learning_level` (the student's level at that moment, where applicable). New generators append `journalFormatInstruction(lang)` to the prompt and save `...journalFieldsFromModel(text, lang)` (`server/journalSections.js`); `content` always stays filled as readable text. The model uses fixed `### SUMMARY` etc. headings, not JSON, so LaTeX survives.

## Achievements
- Earned, never clicked: choosing a higher level in `LearningLevelSelector` has no celebration. The celebration (`LevelUpCelebration`) plus an achievement only follow a positive, server-validated verdict on "Ready for a higher level?" in the chat (`readinessCheck: true` → `server/readiness.js`). The tutor appends an invisible `[[LEAP_READINESS …]]` label that the server always strips. The server decides eligibility itself: level from the DB, a minimum amount of student input, and the topic must be an approved course concept.
- Achievements live in `student_achievements` (written only by the server; students read their own rows via RLS), are unique per (user, course, kind, topic_key, level), and point to a journal entry as evidence. Future kinds (quiz, project badges, learning goals) reuse this table.

## Layout
- List rows in the admin (title + badges + buttons) use `ListRow` / `RowActions` (`src/components/ui/`): buttons that do not fit go into "⋯ More", dangerous actions always sit there, separated and in red. Never build a `flex justify-between` row with a button group that is not allowed to shrink.
- Flex children that hold text get `min-w-0`; buttons get `whitespace-nowrap` inside a row that may wrap (`flex-wrap`). Grids inside the admin choose columns by the available space (`grid-cols-[repeat(auto-fill,minmax(min(Xrem,100%),1fr))]`), not by the screen width: the admin content column is much narrower than the screen.
- Check layout with `npm run ui:audit` (Edge via playwright-core; test account via `node --env-file=.env scripts/ui-audit-account.mjs create`). It opens every page and admin tab at 390/1024/1366 px and reports squeezed text, overlap, content sticking out of its card and horizontal scrolling. The report goes to `ui-audit-output/`.

## Sensitive notes
- Do not put secrets in the repo.
- Trust `.env` values only when they are actually loaded and resolved in the runtime environment.
- For Azure calls, use the configured deployment names and API version; do not silently fallback to public OpenAI for embeddings.
