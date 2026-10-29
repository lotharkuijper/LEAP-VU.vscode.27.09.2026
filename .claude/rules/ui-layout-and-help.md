---
paths:
  - "src/**/*.tsx"
  - "src/index.css"
  - "tailwind.config.js"
  - "src/help/**"
  - "src/components/help/**"
  - "scripts/ui-audit*.mjs"
---

# UI: look and feel, admin layout and help texts

## Look and feel
- Colours come from the LEAP palette: CSS variables `--leap-brand-*`, `--leap-ink-*`, `--leap-accent-*` in `src/index.css`, wired up in `tailwind.config.js`. Use `brand-*` for the main colour, `ink-*` for neutrals and `accent-*` for successes/rewards. `blue`/`sky` map to brand and `gray`/`slate` to ink, so existing classes follow the palette. Never hard-code hex colours in components.
- Font: Nunito, self-hosted via `@fontsource-variable/nunito` (no Google Fonts link). Formulas are rendered by KaTeX in its own fonts.

## Help texts and hints
- Help texts in the admin ("?" buttons, `src/components/help/HelpTip.tsx`) belong to a FUNCTION, not a place: ids live in `src/help/helpTopics.ts`, texts under `help.<id>.title/body`. When restructuring the admin, move the `<HelpTip>` with its control, update the text if the behaviour changed, and remove the id when a function disappears. `src/help/__tests__/helpTopics.test.ts` fails on unknown, unused or stray help ids.
- Student pages use the same `<HelpTip>` with `always` (stays visible even when a teacher switched "Uitleg tonen" off in that browser), ids under `student.*` (2026-10-20). Only for controls whose effect is not obvious; each text says what happens, what is stored and who sees it (e.g. "je docent ziet het niet"). The Ontwerphulp reads these too (`OTHER_PAGES`, group `student`; see `design-assistant.md`).
- Icon-only buttons get `<Tooltip label={t(…)}>` (`src/components/help/Tooltip.tsx`: hover + keyboard focus, sets aria-label) instead of `title=`. Explanation text in the admin uses `<AdminHint variant="intro|tip|warning">` (`src/components/help/AdminHint.tsx`) instead of ad-hoc grey lines or blue boxes; `tip` and all HelpTips disappear when the teacher switches "Uitleg tonen" off (`HelpToggle`, `src/components/help/helpVisibility.ts`).
- All texts go through i18n: see `i18n.md` and the `add-ui-text` skill.

## Admin layout
- The Beheer menu follows the order of setting up a course (2026-10-26, `tabGroups` in `src/pages/AdminPage.tsx`, same order in `ADMIN_SECTIONS`): Inhoud (Cursusmateriaal, Projecten), AI-tutor (Tutor-instructies, Zoekgevoeligheid AI), Quiz (Bronnen van quizvragen, Vraagbanken importeren), Openstellen (Onderdelen aan/uit, Deelnemers toevoegen), Volgen (Analytics); Systeem for admins. Keep new tabs in this logic.
- List rows in the admin (title + badges + buttons) use `ListRow` / `RowActions` (`src/components/ui/`): buttons that do not fit go into "⋯ More", dangerous actions always sit there, separated and in red. Never build a `flex justify-between` row with a button group that is not allowed to shrink.
- A `<HelpTip>` and the control it explains form ONE non-wrapping block (`<span className="flex flex-nowrap items-center gap-1">control + HelpTip</span>`) inside a row that may wrap, so the question mark never ends up on another line than its button.
- Flex children that hold text get `min-w-0`; buttons get `whitespace-nowrap` inside a row that may wrap (`flex-wrap`). Grids inside the admin choose columns by the available space (`grid-cols-[repeat(auto-fill,minmax(min(Xrem,100%),1fr))]`), not by the screen width: the admin content column is much narrower than the screen.
- Admin modals that can grow taller than the screen are rendered with `createPortal(…, document.body)`. The sticky top bar is z-50, and a modal inside the page content would fall behind it.
- Check layout with `npm run ui:audit` (Edge via playwright-core; test account via `node --env-file=.env scripts/ui-audit-account.mjs create`). It opens every page and admin tab at 390/1024/1366 px and reports squeezed text, overlap, content sticking out of its card and horizontal scrolling. The report goes to `ui-audit-output/` (git-ignored).
