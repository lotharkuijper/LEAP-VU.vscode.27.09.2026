// Zoekvraag verrijken voor korte begripsnamen (2026-10-15). Spiegelt
// server/queryExpansion.js: de naam wordt aangevuld met wat de CURSUS zelf over
// het begrip weet (andere namen, echte kernpunten, begin van de definitie).
// Geen vaste, vakspecifieke synoniemenlijst: LEAP is niet aan één vak gebonden.

export interface QueryExpansionOptions {
  definition?: string | null;
  keyPoints?: string[] | null;
  /** Andere namen van het begrip in deze cursus (concepts.aliases). */
  aliases?: string[] | null;
}

function realKeyPoints(keyPoints: string[] | null | undefined): string[] {
  return (keyPoints || [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^course_id:/i.test(s) && !s.startsWith('['));
}

export function expandQuery(term: string, options: QueryExpansionOptions = {}, _lang: 'nl' | 'en' = 'nl'): string {
  const baseTerm = String(term || '').trim();
  if (!baseTerm) return '';

  const parts: string[] = [baseTerm];
  const names = (options.aliases || []).filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  if (names.length) parts.push(names.join(' '));
  const kp = realKeyPoints(options.keyPoints);
  if (kp.length) parts.push(kp.join(' '));
  if (typeof options.definition === 'string' && options.definition.trim()) {
    parts.push(options.definition.replace(/\s+/g, ' ').trim().slice(0, 200));
  }

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    for (const raw of part.split(/\s+/)) {
      const token = raw.trim();
      if (!token) continue;
      const lower = token.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      tokens.push(token);
    }
  }
  return tokens.join(' ');
}
