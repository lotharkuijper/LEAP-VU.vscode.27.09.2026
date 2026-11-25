// Routes bij "Begrippen zoeken" en "Klaar voor studenten" (2026-11-25):
// waar kan LEAP zoeken, verwijderde begrippen weer toelaten, en de uitleg
// (definitie) van een begrip aanpassen. Logica in conceptSearchScope.js;
// keuzes in docs/decisions/cursusmateriaal-en-rag.md.

import { conceptKey } from './conceptConsolidation.js';
import { conceptCourseId, describeSearchScope, parseRemovedKeys, parseSearchRecord } from './conceptSearchScope.js';
import { conceptRegenKey, conceptRemovedKey, readKeyValue, writeKeyValue } from '../lib/keyValue.js';
import { sanitizeText } from '../lib/sanitizeText.js';

const MAX_REMOVED = 2000;
const MAX_DEFINITION = 2000;

/**
 * Begrippen (uit ids) waar de docent zelf iets aan heeft gekoppeld: itembank-
 * onderdelen of gekozen quizbronnen. Bewust GEEN studentgegevens (keepAsHidden).
 */
export async function linkedConceptIds(db, ids) {
  const linked = new Set();
  if (!ids || ids.length === 0) return linked;
  for (const table of ['concept_itembank_sections', 'concept_rag_sources']) {
    const { data, error } = await db.from(table).select('concept_id').in('concept_id', ids);
    if (error) throw new Error(`Controle op gekoppelde gegevens mislukt: ${error.message}`);
    for (const r of data || []) linked.add(r.concept_id);
  }
  return linked;
}

/** Onthoud dat deze begrippen bewust zijn verwijderd (hooguit de laatste 2000). */
export async function rememberRemovedConcepts(db, courseId, names) {
  const keys = names.map(conceptKey).filter(Boolean);
  if (!courseId || keys.length === 0) return;
  const current = parseRemovedKeys(await readKeyValue(db, conceptRemovedKey(courseId)));
  for (const k of keys) current.add(k);
  await writeKeyValue(db, conceptRemovedKey(courseId), JSON.stringify([...current].slice(-MAX_REMOVED)));
}

/**
 * deps: supabaseAdmin, requireConceptStaff(req, res, courseId) (beheerder of
 * docent van precies deze cursus), conceptSourceDocIds(courseId) (leerstof
 * waaruit begrippen komen).
 */
export function registerConceptSearchRoutes(app, deps) {
  const { supabaseAdmin, requireConceptStaff, conceptSourceDocIds } = deps;

  // GET /api/admin/concepts/search-scope?courseId= — de leerstof met per document
  // of het nieuw of gewijzigd is sinds de laatste zoektocht, plus hoeveel
  // verwijderde begrippen worden overgeslagen.
  app.get('/api/admin/concepts/search-scope', async (req, res) => {
    const courseId = String(req.query.courseId || '');
    if (!(await requireConceptStaff(req, res, courseId))) return;
    try {
      const ids = await conceptSourceDocIds(courseId);
      const { data: docs, error } = ids.length
        ? await supabaseAdmin.from('documents').select('id, title, filename, created_at, updated_at').in('id', ids)
        : { data: [], error: null };
      if (error) return res.status(500).json({ error: error.message });
      const record = await readKeyValue(supabaseAdmin, conceptRegenKey(courseId));
      const removed = parseRemovedKeys(await readKeyValue(supabaseAdmin, conceptRemovedKey(courseId)));
      return res.json({
        documents: describeSearchScope(docs || [], record),
        lastSearchAt: parseSearchRecord(record).lastRegenAt,
        removedCount: removed.size,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/admin/concepts/removed-reset { courseId } — verwijderde begrippen
  // mogen bij een volgende zoektocht weer terugkomen.
  app.post('/api/admin/concepts/removed-reset', async (req, res) => {
    const courseId = String(req.body?.courseId || '');
    if (!(await requireConceptStaff(req, res, courseId))) return;
    try {
      await writeKeyValue(supabaseAdmin, conceptRemovedKey(courseId), '[]');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // PATCH /api/admin/concepts/:id { courseId, definition } — de docent past aan
  // hoe LEAP een begrip uitlegt. Die definitie gebruiken Ik leg uit en de quiz.
  app.patch('/api/admin/concepts/:id', async (req, res) => {
    const courseId = String(req.body?.courseId || '');
    if (!(await requireConceptStaff(req, res, courseId))) return;
    const definition = typeof req.body?.definition === 'string' ? sanitizeText(req.body.definition).trim() : '';
    if (!definition) return res.status(400).json({ error: 'Definitie mag niet leeg zijn' });
    if (definition.length > MAX_DEFINITION) return res.status(400).json({ error: 'Definitie is te lang (hooguit 2000 tekens)' });
    try {
      const { data: found, error: findErr } = await supabaseAdmin
        .from('concepts').select('id, course_id, key_points').eq('id', req.params.id).maybeSingle();
      if (findErr) return res.status(500).json({ error: findErr.message });
      // Zelfde regel als bij verwijderen: course_id gaat voor de oude markering.
      if (!found || conceptCourseId(found) !== courseId) return res.status(404).json({ error: 'Begrip niet gevonden in deze cursus' });
      const { error } = await supabaseAdmin.from('concepts').update({ definition }).eq('id', found.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ id: found.id, definition });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });
}
