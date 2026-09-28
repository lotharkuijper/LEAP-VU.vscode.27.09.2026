import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { MoreHorizontal, Loader2 } from 'lucide-react';
import { useLanguage } from '../../i18n';

export type ActionTone = 'default' | 'primary' | 'success' | 'warning' | 'danger';

export interface RowAction {
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  /** Toont een draaiertje in plaats van het pictogram. */
  busy?: boolean;
  tone?: ActionTone;
  /** Extra uitleg: tooltip bij een knop, tweede regel in het menu. */
  title?: string;
  testId?: string;
  /** Altijd in het ⋯-menu (weinig gebruikt). Gevaarlijke acties staan daar standaard. */
  inMenu?: boolean;
}

const GAP = 4; // gap-1

/**
 * Pure: hoeveel knoppen passen naast elkaar in `available` pixels?
 * Past alles en is er geen menu nodig, dan alles; anders zoveel als er passen
 * naast de ⋯-knop. Zonder meting (0 px, bv. in tests) tonen we alles.
 */
export function fitCount(widths: number[], available: number, moreWidth: number, menuNeeded: boolean): number {
  if (available <= 0) return widths.length;
  const total = widths.reduce((a, w) => a + w, 0) + GAP * Math.max(0, widths.length - 1);
  if (!menuNeeded && total <= available) return widths.length;
  let used = moreWidth;
  let n = 0;
  for (const w of widths) {
    if (used + GAP + w > available) break;
    used += GAP + w;
    n++;
  }
  return n;
}

const TONE_INLINE: Record<ActionTone, string> = {
  default: 'text-slate-700 hover:text-slate-900 hover:bg-slate-100',
  primary: 'text-blue-700 hover:text-blue-900 hover:bg-blue-50',
  success: 'text-green-700 hover:text-green-900 hover:bg-green-50',
  warning: 'text-amber-700 hover:text-amber-900 hover:bg-amber-50',
  danger: 'text-red-700 hover:text-red-900 hover:bg-red-50',
};
const TONE_MENU: Record<ActionTone, string> = {
  default: 'text-slate-700 hover:bg-slate-100',
  primary: 'text-blue-700 hover:bg-blue-50',
  success: 'text-green-700 hover:bg-green-50',
  warning: 'text-amber-700 hover:bg-amber-50',
  danger: 'text-red-700 hover:bg-red-50',
};

function ActionContent({ a }: { a: RowAction }) {
  const Icon = a.icon;
  return (
    <>
      {a.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {a.label}
    </>
  );
}
const inlineCls = 'inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent';

/**
 * Knoppen van een lijstrij. Zoveel als er passen staan naast elkaar; de rest
 * (en altijd de gevaarlijke acties, apart en in rood) zit onder "⋯ Meer".
 * Zo wordt de titel van de rij nooit samengeperst en valt er niets over elkaar.
 */
export function RowActions({ actions, align = 'end', menuTestId }: {
  actions: RowAction[];
  /** 'responsive': links op een telefoon, rechts vanaf sm-breedte. */
  align?: 'start' | 'end' | 'responsive';
  menuTestId?: string;
}) {
  const { t } = useLanguage();
  const inlineCandidates = actions.filter(a => !a.inMenu && a.tone !== 'danger');
  const forcedMenu = actions.filter(a => a.inMenu || a.tone === 'danger');
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(inlineCandidates.length);
  const [open, setOpen] = useState(false);
  const [menuLeft, setMenuLeft] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const signature = inlineCandidates.map(a => `${a.key}:${a.label}:${a.busy ? 1 : 0}`).join('|');

  const recompute = useCallback(() => {
    const box = containerRef.current;
    const m = measureRef.current;
    if (!box || !m) return;
    const widths = [...m.children].map(c => (c as HTMLElement).getBoundingClientRect().width);
    const buttonWidths = widths.slice(0, inlineCandidates.length);
    const moreWidth = widths[inlineCandidates.length] ?? 0;
    setVisible(fitCount(buttonWidths, box.clientWidth, moreWidth, forcedMenu.length > 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, forcedMenu.length]);

  useLayoutEffect(() => {
    recompute();
    const box = containerRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(box);
    return () => ro.disconnect();
  }, [recompute]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !moreRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); moreRef.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = inlineCandidates.slice(0, visible);
  const overflow = [...inlineCandidates.slice(visible), ...forcedMenu];
  const safeItems = overflow.filter(a => a.tone !== 'danger');
  const dangerItems = overflow.filter(a => a.tone === 'danger');

  const toggleMenu = () => {
    const r = moreRef.current?.getBoundingClientRect();
    setMenuLeft(!!r && r.right < 240);
    setOpen(o => !o);
  };
  const choose = (a: RowAction) => { setOpen(false); a.onClick(); };

  const menuItem = (a: RowAction) => (
    <button
      key={a.key}
      type="button"
      role="menuitem"
      disabled={a.disabled || a.busy}
      onClick={() => choose(a)}
      className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${TONE_MENU[a.tone || 'default']}`}
      data-testid={a.testId}
    >
      <span className="mt-0.5 flex-shrink-0">{a.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : a.icon ? <a.icon className="h-4 w-4" /> : null}</span>
      <span className="min-w-0">
        <span className="block font-medium">{a.label}</span>
        {a.title && <span className="block text-xs font-normal text-slate-500">{a.title}</span>}
      </span>
    </button>
  );

  return (
    <div ref={containerRef} className={`relative flex min-w-0 flex-1 items-center gap-1 ${align === 'end' ? 'justify-end' : align === 'start' ? 'justify-start' : 'justify-start sm:justify-end'}`} data-testid="row-actions">
      {/* Onzichtbare meetlaag: breedte van elke knop en van "⋯ Meer". In een vak
          van 0×0 met overflow hidden, zodat hij de pagina nooit breder maakt. */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max gap-1">
          {inlineCandidates.map(a => (
            <span key={a.key} className={`${inlineCls} ${TONE_INLINE[a.tone || 'default']}`}><ActionContent a={a} /></span>
          ))}
          <span className={inlineCls}><MoreHorizontal className="h-3.5 w-3.5" />{t('common.more')}</span>
        </div>
      </div>

      {shown.map(a => (
        <button
          key={a.key}
          type="button"
          onClick={a.onClick}
          disabled={a.disabled || a.busy}
          title={a.title}
          className={`${inlineCls} ${TONE_INLINE[a.tone || 'default']}`}
          data-testid={a.testId}
        >
          <ActionContent a={a} />
        </button>
      ))}

      {overflow.length > 0 && (
        <div className="relative flex-shrink-0">
          <button
            ref={moreRef}
            type="button"
            onClick={toggleMenu}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('common.moreActions')}
            className={`${inlineCls} text-slate-600 hover:bg-slate-100 hover:text-slate-900 ${open ? 'bg-slate-100' : ''}`}
            data-testid={menuTestId}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />{t('common.more')}
          </button>
          {open && (
            <div
              ref={menuRef}
              role="menu"
              className={`absolute top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl bg-white p-1 shadow-lg ring-1 ring-slate-200 ${menuLeft ? 'left-0' : 'right-0'}`}
            >
              {safeItems.map(menuItem)}
              {dangerItems.length > 0 && safeItems.length > 0 && <div className="my-1 border-t border-slate-100" role="separator" />}
              {dangerItems.map(menuItem)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
