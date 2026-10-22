import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, X } from 'lucide-react';
import { MathfieldElement } from 'mathlive';
import { useLanguage } from '../../i18n';
import { getActiveLang } from '../../i18n/activeLang';

// Visuele formule-editor (MathLive, 2026-10-22). Wat je typt, staat er meteen
// opgemaakt: / maakt een breuk, ^ een macht, _ een index, "sqrt" een wortel.
// Wie liever klikt, gebruikt de knoppen; op een tablet is er een
// schermtoetsenbord. De formule gaat als LaTeX ($…$) het tekstvak in.
//
// Lettertypen: dezelfde KaTeX-fonts die de app al zelf host (katex.min.css in
// main.tsx); MathLive laadt dus niets van buiten. Geen geluiden.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

type Item = { label: string; latex: string; titleKey?: string };

const GROUPS: Item[][] = [
  [
    { label: 'a⁄b', latex: '\\frac{#@}{#?}', titleKey: 'formula.tool.fraction' },
    { label: 'xⁿ', latex: '#@^{#?}', titleKey: 'formula.tool.power' },
    { label: 'xᵢ', latex: '#@_{#?}', titleKey: 'formula.tool.subscript' },
    { label: '√', latex: '\\sqrt{#0}', titleKey: 'formula.tool.sqrt' },
    { label: 'ⁿ√', latex: '\\sqrt[#?]{#0}', titleKey: 'formula.tool.root' },
    { label: '( )', latex: '\\left(#0\\right)', titleKey: 'formula.tool.parens' },
    { label: '|x|', latex: '\\left|#0\\right|', titleKey: 'formula.tool.abs' },
  ],
  [
    { label: 'Σ', latex: '\\sum_{#?}^{#?}', titleKey: 'formula.tool.sum' },
    { label: '∫', latex: '\\int_{#?}^{#?}', titleKey: 'formula.tool.integral' },
    { label: 'lim', latex: '\\lim_{#?}', titleKey: 'formula.tool.limit' },
    { label: 'x̄', latex: '\\overline{#@}', titleKey: 'formula.tool.bar' },
    { label: 'x̂', latex: '\\hat{#@}', titleKey: 'formula.tool.hat' },
    { label: '→', latex: '\\to', titleKey: 'formula.tool.arrow' },
    { label: '∞', latex: '\\infty' },
  ],
  [
    { label: '±', latex: '\\pm' }, { label: '×', latex: '\\times' }, { label: '·', latex: '\\cdot' },
    { label: '≤', latex: '\\le' }, { label: '≥', latex: '\\ge' }, { label: '≠', latex: '\\ne' }, { label: '≈', latex: '\\approx' },
  ],
  [
    { label: 'α', latex: '\\alpha' }, { label: 'β', latex: '\\beta' }, { label: 'γ', latex: '\\gamma' }, { label: 'δ', latex: '\\delta' },
    { label: 'θ', latex: '\\theta' }, { label: 'λ', latex: '\\lambda' }, { label: 'μ', latex: '\\mu' }, { label: 'π', latex: '\\pi' },
    { label: 'σ', latex: '\\sigma' }, { label: 'φ', latex: '\\varphi' }, { label: 'ω', latex: '\\omega' }, { label: 'Δ', latex: '\\Delta' },
  ],
];

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export default function FormulaDialog({ initialLatex, initialDisplay, editing, onInsert, onCancel }: {
  initialLatex: string;
  initialDisplay: boolean;
  editing: boolean;
  onInsert: (latex: string, display: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);
  const [display, setDisplay] = useState(initialDisplay);
  const [empty, setEmpty] = useState(!initialLatex.trim());
  const displayRef = useRef(display);
  displayRef.current = display;

  useEffect(() => {
    try { MathfieldElement.locale = getActiveLang(); } catch { /* onbekende taal: Engels */ }
    // Instellingen gaan als attribuut vóór het koppelen (eigenschappen zetten mag
    // pas als het veld op de pagina staat: anders "Mathfield not mounted").
    const mf = new MathfieldElement();
    mf.setAttribute('math-virtual-keyboard-policy', 'manual');
    mf.setAttribute('smart-fence', 'on');
    mf.textContent = initialLatex;
    mf.setAttribute('aria-label', t('formula.fieldLabel'));
    mf.setAttribute('data-testid', 'formula-field');
    mf.style.width = '100%';
    mf.style.fontSize = '1.35rem';
    mf.style.padding = '0.5rem 0.75rem';
    mf.style.border = '1px solid rgb(var(--leap-ink-300))';
    mf.style.borderRadius = '0.75rem';
    mf.addEventListener('input', () => setEmpty(!mf.value.trim()));
    mf.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onInsert(mf.value, displayRef.current); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    });
    hostRef.current?.appendChild(mf);
    mfRef.current = mf;
    try { mf.menuItems = []; } catch { /* oudere versie: menu blijft */ }
    requestAnimationFrame(() => mf.focus());
    return () => {
      try { window.mathVirtualKeyboard?.hide(); } catch { /* niets */ }
      mf.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insertItem = (latex: string) => {
    const mf = mfRef.current;
    if (!mf) return;
    mf.insert(latex, { selectionMode: 'placeholder', focus: true });
    setEmpty(!mf.value.trim());
  };

  const toggleKeyboard = () => {
    const kb = window.mathVirtualKeyboard;
    mfRef.current?.focus();
    if (kb) kb.visible ? kb.hide() : kb.show();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('formula.title')} className="w-full max-w-xl rounded-t-2xl bg-white p-4 shadow-2xl sm:rounded-2xl" data-testid="dialog-formula">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold text-gray-900">{editing ? t('formula.titleEdit') : t('formula.title')}</h2>
          <button type="button" onClick={onCancel} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('common.cancelAction')}><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-2 text-xs text-gray-600">{t('formula.hint')}</p>

        <div ref={hostRef} className="mb-3" />

        <div className="mb-3 space-y-1.5">
          {GROUPS.map((group, gi) => (
            <div key={gi} className="flex flex-wrap gap-1">
              {group.map((it) => (
                <button
                  key={it.latex}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertItem(it.latex)}
                  title={it.titleKey ? t(it.titleKey as TKey) : it.label}
                  aria-label={it.titleKey ? t(it.titleKey as TKey) : it.label}
                  className="min-w-[2.25rem] rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-sm text-gray-800 hover:border-brand-300 hover:bg-brand-50"
                  data-testid={`formula-tool-${gi}-${it.label}`}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleKeyboard}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            data-testid="formula-keyboard"
          >
            <Keyboard className="h-4 w-4" />{t('formula.keyboard')}
          </button>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-700">
            <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} data-testid="formula-display" />
            {t('formula.ownLine')}
          </label>
          <span className="flex-1" />
          <button type="button" onClick={onCancel} className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">{t('common.cancelAction')}</button>
          <button
            type="button"
            onClick={() => onInsert(mfRef.current?.value || '', display)}
            disabled={empty}
            className="whitespace-nowrap rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="formula-insert"
          >
            {editing ? t('formula.update') : t('formula.insert')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
