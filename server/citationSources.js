// Bronverwijzingen [1], [2], … naar cursusmateriaal — gedeeld door de chat
// (/api/chat) en de persona-chat in de projectruimte, zodat beide dezelfde
// verwijsregels aan het model geven en de frontend dezelfde klikbare
// verwijzingen + bronnenlijst kan tonen. Pure functies, los testbaar.

// Instructieblok voor het model: genummerde bronnenlijst + strikte verwijsregels.
// Spiegel van buildSourcesBlock in src/services/llm.service.ts (Ik Leg Uit).
export function buildSourcesInstructionBlock(srcs) {
  if (!Array.isArray(srcs) || srcs.length === 0) return '';
  const numbered = srcs
    .map((s, i) => `[${i + 1}] ${(s && s.title) || 'Onbekende bron'}`)
    .join('\n');
  return `\n\nBronnen uit het cursusmateriaal die je tot je beschikking hebt:\n${numbered}\n\nVerwijsregels (volg deze STRIKT):\n- Verwijs in je antwoord naar een bron met exact de notatie [1], [2], ... direct na de zin waar je die bron gebruikt.\n- Gebruik géén andere verwijsvormen (geen titels, geen URL's, geen voetnoten, geen DOI's).\n- Als je in je antwoord informatie noemt die NIET uit deze bronnen komt maar uit algemene kennis, markeer die zin dan met "(buiten cursusmateriaal)" aan het einde van die zin.`;
}

// Vindplaats uit chunk-metadata: dia-reeks bij PowerPoint, anders pagina-reeks.
// Spiegel van slideRangeFromMetadata/pageRangeFromMetadata in src/services/rag.service.ts.
export function locationFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const range = (startRaw, endRaw) => {
    const start = Number(startRaw);
    if (!Number.isFinite(start) || start < 1) return null;
    const end = Number(endRaw);
    return { start, end: Number.isFinite(end) ? Math.max(start, end) : start };
  };
  if (metadata.source === 'pptx') {
    const r = range(metadata.slideStart, metadata.slideEnd);
    return r ? { slideStart: r.start, slideEnd: r.end } : {};
  }
  const r = range(metadata.pageStart, metadata.pageEnd);
  return r ? { pageStart: r.start, pageEnd: r.end } : {};
}

/**
 * Bouw de RAG-context en de bronnenlijst voor één antwoord.
 * `matched`: chunks uit match_document_chunks (document_id, document_title,
 * content, similarity, metadata), hoogste score eerst.
 * Eén bron per document (maximaal `maxDocs`), genummerd in volgorde van de
 * beste treffer; alle chunks van dat document dragen hetzelfde nummer, zodat
 * [n] in het antwoord altijd naar dezelfde bron in de lijst wijst. Chunks van
 * documenten buiten de top vallen weg (anders zou het model naar een bron
 * kunnen verwijzen die de student niet ziet).
 */
export function buildNumberedRagContext(matched, maxDocs = 5) {
  const sources = [];
  const indexByDoc = new Map();
  const parts = [];
  for (const c of Array.isArray(matched) ? matched : []) {
    const key = c.document_id || c.document_title || '';
    let idx = indexByDoc.get(key);
    if (idx === undefined) {
      if (sources.length >= maxDocs) continue;
      idx = sources.length + 1;
      indexByDoc.set(key, idx);
      sources.push({
        index: idx,
        title: c.document_title || 'Cursusdocument',
        documentId: c.document_id || undefined,
        similarity: typeof c.similarity === 'number' ? c.similarity : 0,
        ...locationFromMetadata(c.metadata),
      });
    }
    parts.push(`[${idx}] ${c.document_title || 'Cursusdocument'}\n${c.content || ''}`);
  }
  return { sources, context: parts.join('\n\n---\n\n') };
}
