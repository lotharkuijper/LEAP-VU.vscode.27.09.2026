// Begrippen zoeken: welke leerstof is al doorzocht, en wat heeft de docent
// bewust weggehaald (2026-11-25).
//
// - Per cursus houdt LEAP bij welke documenten bij een begrippenzoektocht zijn
//   gelezen en wanneer (`searched`: documentId → tijdstip). Daarmee kan de docent
//   kiezen voor "alleen in nieuwe of gewijzigde bestanden".
// - Een begrip dat de docent verwijdert, komt bij een volgende zoektocht niet
//   vanzelf terug (`removed`: lijst conceptKey's). Zelf toevoegen kan altijd.
// - Bij "opnieuw samenstellen" verdwijnt een begrip dat LEAP niet meer vindt
//   alleen als er niets aan vastzit; anders wordt het verborgen.
//
// Pure helpers; de opslag (chatbot_prompts-sleutels) staat in routes.js.

/** Pure: opgeslagen zoekgegevens (JSON-tekst of object) → { lastRegenAt, searched }. */
export function parseSearchRecord(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const searched = {};
  if (src.searched && typeof src.searched === 'object' && !Array.isArray(src.searched)) {
    for (const [id, at] of Object.entries(src.searched)) {
      if (typeof id === 'string' && typeof at === 'string' && !Number.isNaN(Date.parse(at))) searched[id] = at;
    }
  }
  const lastRegenAt = typeof src.lastRegenAt === 'string' && !Number.isNaN(Date.parse(src.lastRegenAt)) ? src.lastRegenAt : null;
  return { lastRegenAt, searched };
}

/** Pure: nieuw record na een zoektocht die deze documenten heeft gelezen. */
export function recordSearch(record, documentIds, at) {
  const prev = parseSearchRecord(record);
  const searched = { ...prev.searched };
  for (const id of documentIds || []) if (typeof id === 'string' && id) searched[id] = at;
  return { lastRegenAt: at, searched };
}

const time = (v) => (v ? Date.parse(v) : NaN);

/**
 * Pure: is dit document nieuw of gewijzigd sinds de begrippen erin zijn gezocht?
 * - Staat het in `searched`: alleen als het daarna is bijgewerkt (opnieuw ingelezen,
 *   ander doel).
 * - Oudere cursussen zonder `searched`: alles wat na de laatste zoektocht is
 *   toegevoegd of bijgewerkt; zonder enige zoektocht is alles nieuw.
 */
export function isUnsearched(doc, record) {
  const rec = parseSearchRecord(record);
  const changedAt = Math.max(time(doc.updated_at) || 0, time(doc.created_at) || 0);
  const at = rec.searched[doc.id];
  if (at) return changedAt > time(at);
  if (Object.keys(rec.searched).length > 0) return true;
  if (!rec.lastRegenAt) return true;
  return changedAt > time(rec.lastRegenAt);
}

/** Pure: leerstofdocumenten met per document of het nieuw/gewijzigd is, nieuwste eerst. */
export function describeSearchScope(docs, record) {
  return (docs || [])
    .map((d) => ({ id: d.id, title: d.title || d.filename || '—', isNew: isUnsearched(d, record) }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.title.localeCompare(b.title, 'nl'));
}

/** Pure: opgeslagen lijst verwijderde begrippen (JSON-tekst) → Set van sleutels. */
export function parseRemovedKeys(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  return new Set((Array.isArray(list) ? list : []).filter((k) => typeof k === 'string' && k));
}

/** Pure: kandidaten zonder de begrippen die de docent eerder heeft verwijderd. */
export function withoutRemoved(candidates, removedKeys, keyOf) {
  if (!removedKeys || removedKeys.size === 0) return { kept: candidates, skipped: [] };
  const kept = [];
  const skipped = [];
  for (const c of candidates) {
    const keys = [c.name, ...(c.aliases || [])].map(keyOf).filter(Boolean);
    if (keys.some((k) => removedKeys.has(k))) skipped.push(c.name); else kept.push(c);
  }
  return { kept, skipped };
}

/**
 * Pure: bij welke cursus hoort een begrip? course_id gaat voor; de oude
 * markering `course_id:<id>` in key_points telt alleen als course_id leeg is.
 */
export function conceptCourseId(row) {
  if (!row) return null;
  if (row.course_id) return row.course_id;
  const tag = (row.key_points || []).find((k) => typeof k === 'string' && k.startsWith('course_id:'));
  return tag ? tag.slice('course_id:'.length) : null;
}

/**
 * Pure: verbergen in plaats van verwijderen? Alleen op grond van wat de docent
 * zelf al weet: het begrip is zichtbaar voor studenten (die kunnen ermee
 * geoefend hebben), of er hangen itembank-onderdelen of gekozen quizbronnen aan.
 * NOOIT op grond van studentgegevens: dan zou de uitkomst verraden of studenten
 * iets met het begrip deden (privacy, docs/decisions/privacy-en-data.md).
 */
export function keepAsHidden(row, linkedIds) {
  const visible = !row.review_status || row.review_status === 'approved';
  return visible || (linkedIds ? linkedIds.has(row.id) : false);
}

/**
 * Pure: verouderde begrippen bij "opnieuw samenstellen": wat keepAsHidden
 * beschermt wordt verborgen, de rest verwijderd.
 */
export function planStaleConcepts(staleIds, protectedIds) {
  const keep = new Set(protectedIds || []);
  const hideIds = [];
  const deleteIds = [];
  for (const id of staleIds || []) (keep.has(id) ? hideIds : deleteIds).push(id);
  return { hideIds, deleteIds };
}
