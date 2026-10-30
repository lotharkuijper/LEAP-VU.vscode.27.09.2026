// Wat kent een persona? (2026-10-27)
//
// Per persona kiest de docent de kennis die de persona gebruikt; studenten zien
// die keuze niet:
//   course_knowledge           'none' | 'all' | 'selected'  (cursusmateriaal)
//   course_knowledge_doc_ids   gekozen cursusbestanden bij 'selected'
//   project_knowledge_doc_ids  gekozen projectdocumenten (project_documents.id)
// Nieuwe persona's kennen niets: alleen hun eigen prompt.
//
// Regels die voor elk project gelden:
//  - Databestanden (soort 'data', of een data-extensie zonder andere soort) zijn
//    NOOIT persona-kennis: een persona analyseert geen dataset. Wie verbanden uit
//    de data wil laten kennen, maakt er een verslag van (een gewoon document).
//  - Een chat-persona (Begeleider, Rolspeler) zoekt in zijn projectdocumenten
//    zoals in cursusmateriaal: opgedeeld in fragmenten (ragProcessing.js,
//    indexProjectKnowledgeText). Fragmenten uit documenten die studenten mogen
//    zien, krijgen een bronnummer; uit verborgen documenten gebruikt de persona
//    alleen de inhoud, zonder bron die de student niet kan openen.
//  - Een Beoordelaar leest zijn documenten (rubric, opdracht) in zijn geheel:
//    hij moet de hele rubric toepassen. Alleen documenten van de docent, nooit
//    uploads van studenten (geen sturing van het oordeel via een upload).

export const COURSE_KNOWLEDGE_MODES = ['none', 'all', 'selected'];
export const DATA_EXT_RE = /\.(xlsx|xls|csv|tsv|ods|sav|omv|omt|jasp|rdata|rds|sps|do|dta)$/i;
export const EVALUATOR_DOC_MAX_CHARS = 30000;
export const EVALUATOR_TOTAL_MAX_CHARS = 60000;
// Valt een gekozen document (nog) niet te doorzoeken, dan gaat het begin mee.
export const UNINDEXED_FALLBACK_CHARS = 6000;
const MAX_IDS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Databestand? Een uitdrukkelijk gekozen andere soort (bijv. literatuur) gaat voor de extensie. */
export function isDataDocument(doc) {
  const kind = doc?.material_kind;
  if (kind === 'data') return true;
  if (kind) return false;
  return DATA_EXT_RE.test(String(doc?.filename || ''));
}

/** Mag dit projectdocument kennis van een persona zijn? Geen data, wel tekst. */
export function canBeKnowledge(doc) {
  if (!doc || isDataDocument(doc)) return false;
  if (typeof doc.has_text === 'boolean') return doc.has_text;
  return String(doc.content_text || '').trim().length > 0;
}

export function cleanIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && UUID_RE.test(v)))].slice(0, MAX_IDS);
}

export function normalizeCourseKnowledge(value) {
  return COURSE_KNOWLEDGE_MODES.includes(value) ? value : 'none';
}

/**
 * Kennisvelden uit een verzoek. partial: alleen meegestuurde velden (PATCH).
 * project: false voor sjablonen (die hebben geen projectdocumenten).
 */
export function knowledgeFieldsFrom(body, { partial = false, project = true } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || 'course_knowledge' in b) out.course_knowledge = normalizeCourseKnowledge(b.course_knowledge);
  if (!partial || 'course_knowledge_doc_ids' in b) out.course_knowledge_doc_ids = cleanIds(b.course_knowledge_doc_ids);
  if (project && (!partial || 'project_knowledge_doc_ids' in b)) out.project_knowledge_doc_ids = cleanIds(b.project_knowledge_doc_ids);
  return out;
}

/**
 * Kennis bij het kopiëren (sjabloon → project, project → sjabloon). Cursuskennis
 * gaat mee (zelfde cursus); projectdocumenten niet: een nieuwe kopie kent nog
 * geen documenten van het project waar hij in komt.
 */
export function copyKnowledgeFields(src, { project = true } = {}) {
  const out = {
    course_knowledge: normalizeCourseKnowledge(src?.course_knowledge),
    course_knowledge_doc_ids: cleanIds(src?.course_knowledge_doc_ids),
  };
  if (project) out.project_knowledge_doc_ids = [];
  return out;
}

/**
 * Houdt alleen ids over die mogen: cursusbestanden uit de leerstof van de cursus,
 * projectdocumenten van dit project die kennis kunnen zijn. Geeft ook terug wat
 * is weggelaten, zodat de route het kan melden in plaats van stil te negeren.
 */
export function filterKnowledgeIds(fields, { courseDocIds = null, projectDocs = null } = {}) {
  const out = { ...fields };
  const dropped = { course: [], project: [] };
  if (Array.isArray(out.course_knowledge_doc_ids) && courseDocIds) {
    const ok = new Set(courseDocIds);
    dropped.course = out.course_knowledge_doc_ids.filter((id) => !ok.has(id));
    out.course_knowledge_doc_ids = out.course_knowledge_doc_ids.filter((id) => ok.has(id));
  }
  if (Array.isArray(out.project_knowledge_doc_ids) && projectDocs) {
    const ok = new Set(projectDocs.filter(canBeKnowledge).map((d) => d.id));
    dropped.project = out.project_knowledge_doc_ids.filter((id) => !ok.has(id));
    out.project_knowledge_doc_ids = out.project_knowledge_doc_ids.filter((id) => ok.has(id));
  }
  if (out.course_knowledge !== undefined && out.course_knowledge !== 'selected') out.course_knowledge_doc_ids = [];
  return { fields: out, dropped };
}

/** Beoordelingsmateriaal voor een Beoordelaar: zijn documenten in hun geheel (met plafond). */
export function buildEvaluatorMaterial(docs, { kindLabel = (d) => (d.material_kind === 'rubric' ? 'Rubric' : 'Document') } = {}) {
  const parts = [];
  let total = 0;
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!canBeKnowledge(d)) continue;
    const text = String(d.content_text || '').slice(0, EVALUATOR_DOC_MAX_CHARS);
    const block = `[${kindLabel(d)}: ${d.filename}]\n${text}`;
    if (total + block.length > EVALUATOR_TOTAL_MAX_CHARS) {
      parts.push(block.slice(0, Math.max(0, EVALUATOR_TOTAL_MAX_CHARS - total)));
      break;
    }
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join('\n\n');
}

/** Wie kent welk projectdocument: { [docId]: [{ id, name }] } voor het overzicht bij de docent. */
export function knownByMap(personas) {
  const map = {};
  for (const p of Array.isArray(personas) ? personas : []) {
    for (const id of cleanIds(p.project_knowledge_doc_ids)) {
      (map[id] = map[id] || []).push({ id: p.id, name: p.name });
    }
  }
  return map;
}

// ── Database ───────────────────────────────────────────────────────────────

const PROJECT_DOC_COLS = 'id, project_id, filename, content_text, material_kind, is_visible_to_students, document_ref_id, created_at';

/** De gekozen projectdocumenten van een persona die kennis mogen zijn, in volgorde van kiezen. */
export async function loadPersonaProjectDocs(db, persona) {
  const ids = cleanIds(persona?.project_knowledge_doc_ids);
  if (!ids.length || !persona?.project_id) return [];
  const { data } = await db.from('project_documents').select(PROJECT_DOC_COLS)
    .eq('project_id', persona.project_id).in('id', ids);
  const byId = new Map((data || []).map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter(canBeKnowledge);
}

/** Beoordelingsmateriaal (tekst) van een Beoordelaar, voor feedbackrondes, "Beoordeling opvragen" en de vooranalyse. */
export async function loadEvaluatorMaterial(db, persona) {
  let p = persona;
  if (p?.id && (!Array.isArray(p.project_knowledge_doc_ids) || !p.project_id)) {
    const { data } = await db.from('project_personas').select('id, project_id, project_knowledge_doc_ids').eq('id', p.id).maybeSingle();
    p = data || p;
  }
  return buildEvaluatorMaterial(await loadPersonaProjectDocs(db, p));
}

/** Zijn de fragmenten van deze documenten er al? { [documentRefId]: aantal } */
export async function chunkCounts(db, refIds) {
  const ids = (refIds || []).filter(Boolean);
  if (!ids.length) return {};
  const { data } = await db.from('documents').select('id, total_chunks').in('id', ids);
  return Object.fromEntries((data || []).map((d) => [d.id, Number(d.total_chunks || 0)]));
}

/**
 * Zorgt dat de gekozen documenten doorzoekbaar zijn. index(doc) maakt de
 * fragmenten (ragProcessing.indexProjectKnowledgeText). Fouten worden gemeld,
 * niet gegooid: een document dat (nog) niet doorzoekbaar is, gaat bij het gesprek
 * met zijn begin mee (UNINDEXED_FALLBACK_CHARS).
 */
export async function ensureIndexed(db, docs, index) {
  const withRef = (docs || []).filter((d) => d.document_ref_id && canBeKnowledge(d));
  const counts = await chunkCounts(db, withRef.map((d) => d.document_ref_id));
  const failed = [];
  for (const d of withRef) {
    if ((counts[d.document_ref_id] || 0) > 0) continue;
    try {
      await index(d);
    } catch (e) {
      failed.push({ id: d.id, filename: d.filename, error: e?.message || String(e) });
    }
  }
  return { failed };
}

/**
 * Context uit de projectdocumenten van een chat-persona. matched: gevonden
 * fragmenten (document_id = documents-rij van het projectdocument); docs: de
 * gekozen projectdocumenten; unindexed: documenten zonder fragmenten (begin gaat mee).
 * Zichtbaar voor studenten → genummerde bron (de student kan hem openen);
 * verborgen → achtergrondkennis zonder bron.
 */
export function buildProjectKnowledgeContext({ matched = [], docs = [], unindexed = [], startIndex = 1, maxDocs = 5 } = {}) {
  const byRef = new Map(docs.filter((d) => d.document_ref_id).map((d) => [d.document_ref_id, d]));
  const sources = [];
  const cited = [];
  const background = [];
  const indexByDoc = new Map();
  const add = (doc, text, similarity) => {
    if (!doc || !text) return;
    if (doc.is_visible_to_students) {
      let idx = indexByDoc.get(doc.id);
      if (idx === undefined) {
        if (sources.length >= maxDocs) return;
        idx = startIndex + sources.length;
        indexByDoc.set(doc.id, idx);
        sources.push({ index: idx, title: doc.filename || 'Document', kind: 'project_document', documentRef: doc.id, ...(typeof similarity === 'number' ? { similarity } : {}) });
      }
      cited.push(`[${idx}] ${doc.filename || 'Document'}\n${text}`);
    } else {
      background.push(`(${doc.filename || 'Document'})\n${text}`);
    }
  };
  for (const c of Array.isArray(matched) ? matched : []) add(byRef.get(c.document_id), c.content || '', c.similarity);
  for (const d of Array.isArray(unindexed) ? unindexed : []) add(d, String(d.content_text || '').slice(0, UNINDEXED_FALLBACK_CHARS));
  return { sources, citedContext: cited.join('\n\n---\n\n'), backgroundContext: background.join('\n\n---\n\n') };
}
