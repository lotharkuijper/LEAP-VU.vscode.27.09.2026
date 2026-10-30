# LEAP-VU

LEAP is a learning platform of the Vrije Universiteit Amsterdam. Its question: how can AI make students think more, and better, about the material of *their* course?
- **Grounded in course material.** Tutor, quiz, explanations and concepts come from the teacher's own documents and cite them. When evidence is thin, LEAP says so instead of inventing.
- **AI makes students think; it is no answer machine.** Socratic questions, explaining in their own words, practice, feedback with a next step, reflection.
- **The teacher stays in charge** of material, concepts, sources and which parts are on.
- **Privacy is a condition for learning.** Teachers see who is in their course and groups, never what students do.
- **Subject-neutral, VU/EU context.** Nothing belongs to one discipline; everything runs in the VU Azure tenant; 20 UI languages.

Stack: React + TypeScript + Vite (`src/`), Node/Express (`server/`), self-hosted Supabase (auth, database API, storage) on Azure, Azure OpenAI.

## Where to look
- `docs/README.md`: what is where. `docs/architecture.md`: how it runs on Azure. `docs/security/README.md`: the security model.
- `docs/decisions/`: product decisions per area (privacy, course material, chat/explain/quiz, projects, access/Canvas, technical conventions). Read the relevant one before changing that area, and update it when a decision changes.

## Always
- Privacy: teachers never see student learning data or group content; analytics only as aggregates. Tests guard this; never weaken them.
- Grounding: never let the AI fall back to its own knowledge when course evidence is missing; report the gap.
- Security: every route checks who may do this for this specific course, group or document. Secrets live only in Key Vault and `.env`; never print or commit them. The repo is public: never describe an unfixed weakness in code, commits or docs.
- Database changes only as a new migration with a rollback, tested on the local database (`npm run db:local`).
- No user-visible text exists only in Dutch (i18n; `src/i18n/locales/nl.json` is the source).
- **A push to `main` deploys to production**, including migrations. Prefer a branch and a pull request so the `Tests` workflow runs first. If it fails, find and fix the cause; never skip or weaken a test.

## Big changes
For a change that touches several areas, login, access, the database or Azure: before calling it done, run the `security-reviewer` and `code-maintainability-reviewer` agents, fix what they find, and remove anything the change left unused.

## Checking your work
`npx vitest run` (or one test file), `npm run typecheck`, `npx eslint server`, `npx vite build`, and for database rules `npm run db:local` + `bash scripts/local-db/test.sh`. Say which checks you ran and what they returned.

## Working with Lothar
Lothar, the product owner, writes in Dutch and lets Claude write the code; he reviews by using the app. Answer in plain Dutch. When he asks a question, explain first before changing things. Before changing something on Azure or in production data, say in one line what you are about to change. Keep commits small with a short reason, flag security trade-offs openly, and end with what changed for students and teachers, what you tested, and what needs his decision.
