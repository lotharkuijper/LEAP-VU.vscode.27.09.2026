---
paths:
  - "src/components/MathText.tsx"
  - "src/components/MarkdownMessage.tsx"
  - "src/components/formula/**"
  - "src/lib/{mathText,mathDelimiters}.ts"
  - "src/lib/__tests__/mathText.test.tsx"
---

# Formulas (2026-10-22)

- TeX typed by students is ALWAYS rendered, everywhere their text is shown: `MathText` (`src/components/MathText.tsx`, only formulas, the rest stays plain text) for chat bubbles, quiz answers, project group chat and persona chat; `MarkdownMessage` (`src/components/MarkdownMessage.tsx`) elsewhere. Delimiters: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`. Single dollars follow the Pandoc rule (`splitMath` in `src/lib/mathText.ts`), and `guardCurrencyDollars` keeps "$10 en $20" out of math in MarkdownMessage. KaTeX with `trust: false` (no links).
- The visual editor is OPT-IN per course (`formulaEditor` in `OPT_IN_FEATURES`, Onderdelen): a ∑ button (`FormulaButton`, `src/components/formula/`) next to every student text field (chat, Ik leg uit in both modes, quiz open/casus answers, Studiecafé new thread and reply, journal note, project group chat, persona chat, final reflection). The dialog (`FormulaDialog`) uses MathLive 0.111.0, lazy-loaded on the first click; fonts come from the self-hosted katex.min.css (`fontsDirectory`/`soundsDirectory` = null). Set MathLive options as attributes BEFORE mounting, otherwise "Mathfield not mounted". It inserts `$latex$` at the cursor; with the cursor inside a formula it opens that formula for editing. The old Studiecafé toolbar (FormulaEditor) is gone. Tests: `src/lib/__tests__/mathText.test.tsx`.
- Formulas are rendered by KaTeX in its own fonts (the UI font is Nunito, see `ui-layout-and-help.md`).
