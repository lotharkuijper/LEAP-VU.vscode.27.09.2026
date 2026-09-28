import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { helpBodyKey, helpTitleKey, type HelpId } from '../../help/helpTopics';
import { useHelpVisible } from './helpVisibility';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/**
 * Vraagteken naast een functie in het beheer. Klikken (of Enter/spatie) opent
 * een klein uitlegkader; nog eens klikken, Esc of ernaast klikken sluit het.
 * Werkt dus ook op aanraakschermen en met het toetsenbord, anders dan hover.
 *
 * De tekst komt uit de vertaalbestanden via de id (src/help/helpTopics.ts),
 * zodat de uitleg met de functie meeverhuist bij een herinrichting.
 */
export function HelpTip({ id, className = '' }: { id: HelpId; className?: string }) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const title = tk(helpTitleKey(id));
  const visible = useHelpVisible();

  // Klap naar links uit als het kader anders buiten beeld valt.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAlignRight(rect.left + 300 > window.innerWidth);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // "Uitleg tonen" staat uit: geen vraagteken tonen.
  if (!visible) return null;

  return (
    // Wie de HelpTip zelf positioneert (absolute/fixed), krijgt geen `relative`:
    // die wint in Tailwind van `absolute` en zette het vraagteken dan ónder de kaart.
    <span ref={wrapRef} className={`${/\b(absolute|fixed)\b/.test(className) ? '' : 'relative '}inline-flex align-middle ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={`inline-flex items-center justify-center w-5 h-5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${open ? 'text-sky-700 bg-sky-100' : 'text-gray-400 hover:text-sky-700 hover:bg-sky-50'}`}
        aria-label={t('help.buttonLabel', { topic: title })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={`help-${id}`}
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <span
          id={panelId}
          role="dialog"
          aria-label={title}
          className={`absolute z-50 top-full mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-sky-200 bg-white p-3 text-left shadow-lg ${alignRight ? 'right-0' : 'left-0'}`}
          onClick={(e) => e.stopPropagation()}
          data-testid={`help-panel-${id}`}
        >
          <span className="flex items-start gap-2">
            <span className="flex-1 text-sm font-semibold text-gray-900">{title}</span>
            <button
              type="button"
              onClick={() => { setOpen(false); buttonRef.current?.focus(); }}
              className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
              aria-label={t('help.close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-gray-700 whitespace-pre-line font-normal">
            {tk(helpBodyKey(id))}
          </span>
        </span>
      )}
    </span>
  );
}
