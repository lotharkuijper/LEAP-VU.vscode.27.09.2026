---
name: add-ui-text
description: Workflow for adding or changing any text a LEAP user can see - React UI strings, help texts ("?" buttons), server error and status messages, and account e-mails - in all 20 languages. Use whenever a change adds, renames or rewrites user-visible text.
---

# Adding or changing user-visible text

Rule: no user-visible text exists only in Dutch. Prompts sent to the language model are not UI text and are not translated.

## A. Text in the React app
1. Add the key to `src/i18n/locales/nl.json` (the source of truth), in the namespace of the feature (`chat.*`, `quiz.*`, `admin.*`, …). Generic words (Annuleren, Bezig…) use existing `common.*` keys; never borrow a key from another feature.
2. Add the same key to `src/i18n/locales/en.json` by hand (a real English text, not a machine echo).
3. Use it: `const { t } = useLanguage()` (from `src/i18n`) and `t('key')` in components, `tStatic(getActiveLang(), 'key')` outside React (`src/i18n/translations.ts`, `src/i18n/activeLang.ts`). Placeholders like `{count}` as in nearby keys.
4. Fill the other 18 languages: `node --env-file=.env scripts/i18n-generate.mjs`. It stops after ~110 s; run it again until it prints `RESTEREND totaal: 0`. It uses the VU Azure OpenAI resource (costs a little; needs `.env`). To limit languages: `LANGS=de,fr node --env-file=.env scripts/i18n-generate.mjs`.
5. Changed the Dutch meaning of an existing key? The generator only fills MISSING keys: remove the key from the other locale files (not from `nl.json`/`en.json`) first, then run the generator.
6. Check: `npx vitest run src/__tests__/languageRegistrySync.test.ts` (key parity across all locales).

## B. Help texts ("?" buttons)
1. A help text belongs to a FUNCTION, not a place. Add an id to `src/help/helpTopics.ts` (`material.addWebsite`, not `tab3.button2`).
2. Texts under `help.<id>.title` and `help.<id>.body` in `nl.json` (+ `en.json`, then the generator). Plain language, no jargon (no "RAG", "chunks", "embeddings"), about 40 words: what it does and what students notice.
3. Place `<HelpTip id="…" />` in ONE non-wrapping block with its control (`.claude/rules/ui-layout-and-help.md`). Student pages: `<HelpTip always … />`, ids under `student.*`, and say what is stored and who sees it.
4. A new help group or admin tab also needs `ADMIN_SECTIONS` in `server/system/designAssistant.js`.
5. Check: `npx vitest run src/help/__tests__/helpTopics.test.ts server/__tests__/designAssistant.test.js`.

## C. Server messages (JSON `error`, `message`, `warning`, `hint`)
1. Write the message in Dutch as a literal string in the server code (`res.status(400).json({ error: 'Kies eerst een cursus' })`). Template literals with `${…}` become `{0}`, `{1}` placeholders automatically. Do not build per-language text in the route.
2. Regenerate the source list: `node scripts/extract-server-messages.mjs` (updates `server/i18n/messages.source.json`).
3. Translate: `node --env-file=.env scripts/server-i18n-generate.mjs` (fills `server/i18n/messages.<lang>.json`; run again until nothing is missing).
4. Check: `node scripts/extract-server-messages.mjs --check` and `npx vitest run server/__tests__/serverI18n.test.js`.
5. The middleware in `server/i18n/serverI18n.js` translates each response using the `X-LEAP-Lang` header the app sends; nothing else is needed in the route.

## D. E-mails
- E-mail texts also live in the app's locale files (`email.auth.*` for account e-mails built in `server/account/authEmailHook.js`, `email.digest.*` etc. for notifications); the server reads them through `server/i18n/notificationI18n.js`. Follow the same nl → en → generator steps as in A.

## E. Before you finish
- No Dutch literal left in a component (search your diff for quotes with Dutch words outside `t(…)`).
- UI texts and fixed LLM instructions contain no subject-specific examples (`server/__tests__/subjectNeutral.test.js`).
- Run `npm run typecheck` when you touched `.ts`/`.tsx`.
