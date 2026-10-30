// Zoekvraag verrijken voor korte begripsnamen (2026-10-15).
//
// Korte termen geven het embedding-model weinig signaal. We vullen de naam aan
// met wat de CURSUS zelf over het begrip weet: de andere namen (aliases), de
// echte kernpunten en het begin van de definitie. Er staat bewust geen vaste,
// vakspecifieke synoniemenlijst meer in de code: LEAP is niet aan één vak
// gebonden, en begrippen en hun woorden blijven binnen hun eigen cursus.
// Spiegel: src/services/queryExpansion.ts (browser).

/** Technische labels (course_id:…, [RAG-…]) zijn geen kernpunten. */
function realKeyPoints(keyPoints) {
  return (Array.isArray(keyPoints) ? keyPoints : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s && !/^course_id:/i.test(s) && !s.startsWith('['));
}

// Bouwt een verrijkte zoekstring rond `term`. De originele term blijft als
// belangrijkste signaal vooraan; daarna (in deze volgorde) de andere namen van
// het begrip, de kernpunten en de eerste ~200 tekens van de definitie.
// Gededupliceerd op woordniveau. `lang` blijft voor compatibiliteit.
export function expandQuery(term, options, _lang) {
  const opts = options || {};
  const baseTerm = String(term || '').trim();
  if (!baseTerm) return '';

  const parts = [baseTerm];
  if (Array.isArray(opts.aliases)) {
    const names = opts.aliases.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
    if (names.length) parts.push(names.join(' '));
  }
  const kp = realKeyPoints(opts.keyPoints);
  if (kp.length) parts.push(kp.join(' '));
  if (typeof opts.definition === 'string' && opts.definition.trim()) {
    parts.push(opts.definition.replace(/\s+/g, ' ').trim().slice(0, 200));
  }

  const seen = new Set();
  const tokens = [];
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
