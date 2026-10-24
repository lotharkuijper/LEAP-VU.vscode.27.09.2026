// Volgorde van begrippen in de stof (2026-10-24).
//
// Per begrip: waar komt het VOOR HET EERST voor in het cursusmateriaal? Dat is
// het moment waarop het begrip wordt geïntroduceerd. Studenten zien de
// begrippen (Ik leg uit, quiz) in die volgorde, met een kleurverloop van licht
// (begin van de cursus) naar donker (eind). Niets wordt verborgen: wie een
// begrip al kent, kiest het gewoon.
//
// Volgorde van de stof:
//   - met een leerlijn (course_units): positie van het onderdeel, dan de
//     nummering van het bestand binnen het onderdeel;
//   - zonder leerlijn: de nummering van de bestanden (proposeUnits);
//   - binnen een bestand: chunk_index van het eerste fragment met bewijs.
// Begrippen zonder bewijs in de stof krijgen geen plek (order null).

import { proposeUnits, orderKeyFromName } from './courseUnits.js';

const BIG = 1e9;

function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Volgorde van de documenten.
 * leerlijn: { units: [{ id, title, position }], docUnit: Map(docId → unitId) }
 * material: [{ id, title, filename }]
 * → Map(docId → { rank, unitTitle, unitIndex }) en unitCount (aantal verschillende posities).
 */
export function buildDocOrder({ leerlijn, material }) {
  const docs = material || [];
  const byName = (d) => orderKeyFromName(d.filename || d.title || '') || [BIG];
  const out = new Map();
  let units;
  if (leerlijn && leerlijn.units && leerlijn.units.length) {
    units = [...leerlijn.units].sort((a, b) => a.position - b.position).map(u => ({
      title: u.title, position: u.position,
      documentIds: docs.filter(d => leerlijn.docUnit.get(d.id) === u.id).map(d => d.id),
    }));
  } else {
    units = proposeUnits(docs).units;
  }
  const positions = [...new Set(units.map(u => u.position))].sort((a, b) => a - b);
  const unitIndex = new Map(positions.map((p, i) => [p, i + 1]));
  let rank = 0;
  for (const u of units) {
    const inUnit = docs.filter(d => u.documentIds.includes(d.id))
      .sort((a, b) => compareKeys(byName(a), byName(b)) || String(a.filename || a.title || '').localeCompare(String(b.filename || b.title || '')));
    for (const d of inUnit) {
      if (out.has(d.id)) continue;
      out.set(d.id, { rank: rank++, unitTitle: u.title, unitIndex: unitIndex.get(u.position) });
    }
  }
  // Documenten zonder nummer of zonder plek in de leerlijn: achteraan, zonder onderdeel.
  const rest = docs.filter(d => !out.has(d.id))
    .sort((a, b) => compareKeys(byName(a), byName(b)) || String(a.filename || a.title || '').localeCompare(String(b.filename || b.title || '')));
  for (const d of rest) out.set(d.id, { rank: rank++, unitTitle: null, unitIndex: null });
  return { docOrder: out, unitCount: positions.length };
}

/**
 * Plek per begrip.
 * concepts: [{ id, source_document_ids? }]
 * evidence: [{ concept_id, document_id, chunk_index }]
 * → [{ id, order, pos, unitTitle, unitIndex, unitCount }]; order/pos null = plek onbekend.
 * pos loopt van 0 (eerste begrip) tot 1 (laatste), gelijkmatig over de begrippen verdeeld.
 */
export function conceptPositions({ concepts, evidence, docOrder, unitCount }) {
  const first = new Map();
  const consider = (cid, docId, chunkIndex) => {
    const d = docOrder.get(docId);
    if (!d) return;
    const key = [d.rank, Number.isFinite(chunkIndex) ? chunkIndex : BIG];
    const cur = first.get(cid);
    if (!cur || compareKeys(key, cur.key) < 0) first.set(cid, { key, d });
  };
  for (const e of evidence || []) consider(e.concept_id, e.document_id, Number(e.chunk_index));
  for (const c of concepts || []) {
    if (first.has(c.id)) continue;
    for (const docId of c.source_document_ids || []) consider(c.id, docId, NaN);
  }
  const placed = (concepts || []).filter(c => first.has(c.id))
    .sort((a, b) => compareKeys(first.get(a.id).key, first.get(b.id).key));
  const n = placed.length;
  const out = new Map();
  placed.forEach((c, i) => {
    const { d } = first.get(c.id);
    out.set(c.id, { id: c.id, order: i, pos: n > 1 ? i / (n - 1) : 0, unitTitle: d.unitTitle, unitIndex: d.unitIndex, unitCount });
  });
  return (concepts || []).map(c => out.get(c.id) || { id: c.id, order: null, pos: null, unitTitle: null, unitIndex: null, unitCount });
}

/** Alle rijen ophalen (de API geeft er maximaal 1000 per keer). */
async function fetchAll(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; from < 100000; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

/**
 * Laadt alles voor één cursus en berekent de plekken.
 * deps: db, loadLeerlijn(courseId), courseFolderIds(courseId)
 */
export async function loadConceptOrder({ db, courseId, loadLeerlijn, courseFolderIds }) {
  const folders = await courseFolderIds(courseId);
  const [concepts, leerlijn, docs] = await Promise.all([
    fetchAll(() => db.from('concepts').select('id, source_document_ids').eq('course_id', courseId).eq('review_status', 'approved')),
    loadLeerlijn(courseId),
    folders.length
      ? fetchAll(() => db.from('documents').select('id, title, filename, purpose').in('folder_id', folders))
      : Promise.resolve([]),
  ]);
  const material = docs.filter(d => !d.purpose || d.purpose === 'course_material');
  const { docOrder, unitCount } = buildDocOrder({ leerlijn, material });
  const conceptIds = new Set(concepts.map(c => c.id));
  const ev = (await fetchAll(() => db.from('concept_evidence').select('concept_id, document_id, chunk_id').eq('course_id', courseId)))
    .filter(e => conceptIds.has(e.concept_id) && docOrder.has(e.document_id));
  // chunk_index van de fragmenten, in porties.
  const chunkIds = [...new Set(ev.map(e => e.chunk_id).filter(Boolean))];
  const idx = new Map();
  for (let i = 0; i < chunkIds.length; i += 300) {
    const { data } = await db.from('document_chunks').select('id, chunk_index').in('id', chunkIds.slice(i, i + 300));
    for (const r of data || []) idx.set(r.id, r.chunk_index);
  }
  const evidence = ev.map(e => ({ concept_id: e.concept_id, document_id: e.document_id, chunk_index: idx.get(e.chunk_id) }));
  return conceptPositions({ concepts, evidence, docOrder, unitCount });
}
