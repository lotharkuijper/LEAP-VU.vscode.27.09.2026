import { cloneElement, isValidElement, type ReactElement } from 'react';

type Side = 'top' | 'bottom';

/**
 * Korte tooltip voor knoppen met alleen een pictogram (prullenbak, downloaden,
 * vernieuwen, …). Verschijnt bij aanwijzen ÉN bij toetsenbordfocus, en geeft
 * de knop tegelijk zijn naam voor schermlezers (aria-label). Vervangt het
 * browser-`title`-attribuut, dat traag is, niet werkt op aanraakschermen en
 * vaak niet wordt voorgelezen.
 *
 * Gebruik: <Tooltip label={t('…')}><button …><Trash2 /></button></Tooltip>
 * Alleen voor korte labels (een paar woorden); uitleg hoort in een HelpTip.
 */
export function Tooltip({ label, side = 'top', children }: { label: string; side?: Side; children: ReactElement }) {
  if (!isValidElement(children)) return children;
  const props = children.props as Record<string, unknown>;
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    'aria-label': (props['aria-label'] as string | undefined) ?? label,
    title: undefined,
  });
  return (
    <span className="relative inline-flex group/tooltip">
      {child}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow transition-opacity duration-100 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
        data-testid="tooltip"
      >
        {label}
      </span>
    </span>
  );
}
