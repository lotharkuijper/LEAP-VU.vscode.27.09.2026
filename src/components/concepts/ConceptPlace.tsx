import { useLanguage } from '../../i18n';
import { Tooltip } from '../help/Tooltip';
import { legendGradient, phaseOf, placeColor, type ConceptPlace } from '../../lib/conceptOrder';

// Plek van een begrip in de cursus: een bolletje in een tint van de hoofdkleur,
// licht = begin, donker = eind (src/lib/conceptOrder.ts). De betekenis staat er
// ook in woorden bij (tooltip en schermlezer), niet alleen in kleur.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export function useConceptPlaceText() {
  const { t } = useLanguage();
  return (place: ConceptPlace | undefined): string => {
    const phase = phaseOf(place?.pos);
    const phaseText = t(`conceptOrder.phase.${phase}` as TKey);
    if (!place || phase === 'unknown') return phaseText;
    if (place.unitIndex && place.unitCount > 1) {
      return t('conceptOrder.placeUnit', { phase: phaseText, unit: String(place.unitIndex), total: String(place.unitCount), title: place.unitTitle || '' });
    }
    return phaseText;
  };
}

export function ConceptPlaceDot({ place, className = '' }: { place: ConceptPlace | undefined; className?: string }) {
  const text = useConceptPlaceText()(place);
  return (
    <Tooltip label={text}>
      <span
        role="img"
        aria-label={text}
        className={`inline-block h-3 w-3 flex-shrink-0 rounded-full ring-1 ring-black/5 ${className}`}
        style={{ background: placeColor(place?.pos) }}
        data-testid="concept-place-dot"
        data-pos={place?.pos ?? ''}
      />
    </Tooltip>
  );
}

/** Legenda boven een lijst: "begin ▱▱▰▰ eind van de cursus". */
export function ConceptPlaceLegend({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  return (
    <div className={`flex items-center gap-2 text-[11px] text-gray-500 ${className}`} data-testid="concept-place-legend">
      <span className="whitespace-nowrap">{t('conceptOrder.legendStart')}</span>
      <span className="h-2 min-w-[3rem] flex-1 rounded-full" style={{ background: legendGradient() }} aria-hidden="true" />
      <span className="whitespace-nowrap">{t('conceptOrder.legendEnd')}</span>
    </div>
  );
}
