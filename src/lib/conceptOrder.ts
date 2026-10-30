// Volgorde van begrippen in de stof (server/concepts/conceptOrder.js, 2026-10-24).
// Puur: sorteren, kleur en omschrijving van de plek in de cursus.

export interface ConceptPlace {
  id: string;
  /** Volgnummer van eerste verschijnen in de stof; null = plek onbekend. */
  order: number | null;
  /** 0 = begin van de cursus, 1 = eind; null = onbekend. */
  pos: number | null;
  unitTitle: string | null;
  unitIndex: number | null;
  unitCount: number;
}

export type Phase = 'begin' | 'middle' | 'end' | 'unknown';

/** Tinten van de hoofdkleur, licht (begin) → donker (eind). */
const SHADES = [300, 400, 500, 600, 700, 800, 900, 950] as const;

export function phaseOf(pos: number | null | undefined): Phase {
  if (pos === null || pos === undefined || !Number.isFinite(pos)) return 'unknown';
  if (pos < 1 / 3) return 'begin';
  if (pos < 2 / 3) return 'middle';
  return 'end';
}

/** CSS-kleur van een plek (uit het LEAP-palet, nooit een vaste hexcode). */
export function placeColor(pos: number | null | undefined): string {
  if (pos === null || pos === undefined || !Number.isFinite(pos)) return 'rgb(var(--leap-ink-300))';
  const i = Math.min(SHADES.length - 1, Math.max(0, Math.round(pos * (SHADES.length - 1))));
  return `rgb(var(--leap-brand-${SHADES[i]}))`;
}

/** CSS-verloop voor de legenda. */
export function legendGradient(): string {
  return `linear-gradient(to right, ${SHADES.map(s => `rgb(var(--leap-brand-${s}))`).join(', ')})`;
}

/**
 * Sorteert op volgorde van de stof; begrippen zonder plek achteraan, alfabetisch.
 * Zonder volgorde (null) blijft het alfabetisch.
 */
export function sortByCourseOrder<T>(items: T[], idOf: (x: T) => string, nameOf: (x: T) => string, places: Map<string, ConceptPlace> | null, locale = 'nl'): T[] {
  const alpha = (a: T, b: T) => nameOf(a).localeCompare(nameOf(b), locale, { sensitivity: 'base' });
  if (!places || places.size === 0) return [...items].sort(alpha);
  return [...items].sort((a, b) => {
    const oa = places.get(idOf(a))?.order;
    const ob = places.get(idOf(b))?.order;
    const ha = oa !== null && oa !== undefined;
    const hb = ob !== null && ob !== undefined;
    if (ha && hb) return (oa as number) - (ob as number);
    if (ha !== hb) return ha ? -1 : 1;
    return alpha(a, b);
  });
}
