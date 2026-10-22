import { lazy, Suspense, useState, type RefObject } from 'react';
import { Sigma } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useCourseFeatures } from '../../hooks/useCourseFeatures';
import { Tooltip } from '../help/Tooltip';
import { HelpTip } from '../help/HelpTip';
import { mathAt } from '../../lib/mathText';

// ∑-knop naast een tekstvak van een student (2026-10-22). Alleen zichtbaar als
// de docent de formule-editor voor de cursus aanzette (opt-in 'formulaEditor').
// De editor zelf (MathLive) wordt pas geladen bij de eerste klik.
const FormulaDialog = lazy(() => import('./FormulaDialog'));

type Target = HTMLTextAreaElement | HTMLInputElement;

/** Pure: voegt `$latex$` (of `$$latex$$`) in op de cursor, of vervangt de formule waar de cursor in stond. */
export function insertFormula(value: string, sel: { start: number; end: number }, latex: string, display: boolean, replace?: { start: number; end: number } | null): { next: string; caret: number } {
  const clean = latex.trim();
  const start = replace ? replace.start : sel.start;
  const end = replace ? replace.end : sel.end;
  let piece = display ? `$$${clean}$$` : `$${clean}$`;
  // Regel van Pandoc: na het sluitende $ geen cijfer, en een formule plakt niet aan een woord vast.
  const after = value[end];
  if (after !== undefined && /[0-9A-Za-z]/.test(after)) piece += ' ';
  const before = value[start - 1];
  if (before !== undefined && /[0-9A-Za-z$]/.test(before)) piece = ` ${piece}`;
  if (display) {
    if (before !== undefined && before !== '\n') piece = `\n${piece.trimStart()}`;
    if (after !== undefined && after !== '\n') piece = `${piece.trimEnd()}\n`;
  }
  const next = value.slice(0, start) + piece + value.slice(end);
  return { next, caret: start + piece.length };
}

export function FormulaButton({ targetRef, value, onChange, disabled, testId = 'button-formula' }: {
  targetRef: RefObject<Target>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useLanguage();
  const { features } = useCourseFeatures();
  const [open, setOpen] = useState<null | { latex: string; display: boolean; sel: { start: number; end: number }; replace: { start: number; end: number } | null }>(null);

  if (!features.formulaEditor) return null;

  const openEditor = () => {
    const el = targetRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const existing = mathAt(value, start);
    setOpen({
      latex: existing?.latex ?? '',
      display: existing?.display ?? false,
      sel: { start, end },
      replace: existing ? { start: existing.start, end: existing.end } : null,
    });
  };

  const apply = (latex: string, display: boolean) => {
    if (!open) return;
    if (!latex.trim()) { setOpen(null); return; }
    const { next, caret } = insertFormula(value, open.sel, latex, display, open.replace);
    onChange(next);
    setOpen(null);
    requestAnimationFrame(() => {
      const el = targetRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch { /* sommige invoertypes kennen geen selectie */ }
    });
  };

  return (
    <span className="inline-flex flex-nowrap items-center gap-1">
      <Tooltip label={t('formula.button')}>
        <button
          type="button"
          onClick={openEditor}
          disabled={disabled}
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white p-2 text-gray-600 transition-colors hover:border-brand-400 hover:text-brand-700 disabled:opacity-40"
          data-testid={testId}
        >
          <Sigma className="h-4 w-4" />
        </button>
      </Tooltip>
      <HelpTip id="student.formula" always />
      {open && (
        <Suspense fallback={null}>
          <FormulaDialog
            initialLatex={open.latex}
            initialDisplay={open.display}
            editing={!!open.replace}
            onInsert={apply}
            onCancel={() => { setOpen(null); requestAnimationFrame(() => targetRef.current?.focus()); }}
          />
        </Suspense>
      )}
    </span>
  );
}
