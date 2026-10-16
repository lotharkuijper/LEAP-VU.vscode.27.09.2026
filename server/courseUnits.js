// Leerlijn: de volgorde van de stof in een cursus (2026-10-16, migratie 20261016130000).
//
// Onderdelen hebben een positie; een hogere positie bouwt voort op wat ervoor
// komt, een gelijke positie betekent "naast elkaar". Er zitten geen datums in:
// de leerlijn gaat over de opbouw van de stof, niet over een planning.
//
// In de chat bepaalt de vraag zelf waar de student is (het ANKER: het
// onderdeel van de best passende bronnen, of wat de student zelf kiest). Ten
// opzichte daarvan krijgt elk onderdeel een label:
//   earlier   — voorafgaand: mag als bekend gelden, terugverwijzen mag
//   anchor    — dit onderdeel
//   parallel  — naast dit onderdeel (zelfde positie)
//   later     — verderop: niet als bekend veronderstellen
// Heeft de student een onderdeel verderop (of ernaast) al geoefend, dan mag de
// tutor daar wél op teruggrijpen: de student heeft laten zien er iets van te
// weten. "Geoefend" volgt uit de eigen gegevens van de student (quiz, Ik leg
// uit, chat) en wordt alleen voor de eigen tutorchat gebruikt.
//
// Pure helpers + registerCourseUnitRoutes(app, deps) + loaders voor /api/chat.

// ── Voorstel uit bestandsnamen ───────────────────────────────────────────────
const LEAD_WORDS = '(?:hoorcollege|werkcollege|college|lecture|les|lesson|week|module|hoofdstuk|chapter|deel|part|unit|blok|thema|onderdeel)';

/**
 * Het volgnummer in een bestandsnaam als lijst getallen ("4.1" → [4, 1]):
 * vooraan ("4.1.Confounding"), of na een woord als "Hoorcollege 3". Een cijfer
 * dat aan letters vastzit ("Metho2") telt niet. Geen nummer → null.
 */
export function orderKeyFromName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const lead = base.match(/^\s*(\d+(?:[.,]\d+)*)/);
  if (lead) return lead[1].split(/[.,]/).map(Number);
  const word = base.match(new RegExp(`${LEAD_WORDS}[\\s_-]*(\\d+(?:\\.\\d+)*)`, 'i'));
  if (word) return word[1].split('.').map(Number);
  const loose = base.match(/(?<![A-Za-z\d])(\d+(?:\.\d+)*)(?![A-Za-z\d])/);
  return loose ? loose[1].split('.').map(Number) : null;
}

/** Een leesbare titel uit een bestandsnaam ("4.1.Confounding.docx" → "Confounding"). */
export function titleFromName(name) {
  let s = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  if (s.includes(';')) s = s.slice(s.indexOf(';') + 1);
  s = s.replace(new RegExp(`^.*?${LEAD_WORDS}[\\s_-]*\\d+(?:\\.\\d+)*`, 'i'), '');
  s = s.replace(/^\s*\d+(?:[.,]\d+)*/, '');
  s = s.replace(/_[A-Z]{3,}\b/g, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-–:;\s]+/, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(name || '').trim();
}

function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Voorstel voor een leerlijn: één onderdeel per genummerd bestand, in de
 * volgorde van de nummers (1, 2, 4, 4.1, 4.2, 5, …). Gelijke nummers krijgen
 * dezelfde positie. Bestanden zonder nummer laat het voorstel open.
 * files: [{ id, title?, filename? }]
 * Retour: { units: [{ title, position, documentIds }], unplaced: [documentId] }
 */
export function proposeUnits(files) {
  const numbered = [];
  const unplaced = [];
  for (const f of files || []) {
    const name = f.filename || f.title || '';
    const key = orderKeyFromName(name) || orderKeyFromName(f.title || '');
    if (key) numbered.push({ f, key, name });
    else unplaced.push(f.id);
  }
  // Bij gelijke nummers geeft de kortste naam de titel ("2.b" vóór "2.b-oefeningen").
  numbered.sort((a, b) => compareKeys(a.key, b.key) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  const units = [];
  let position = 0;
  let prevKey = null;
  for (const n of numbered) {
    const same = prevKey && compareKeys(prevKey, n.key) === 0;
    if (!same) position += 1;
    prevKey = n.key;
    if (same) units[units.length - 1].documentIds.push(n.f.id);
    else units.push({ title: titleFromName(n.f.title || n.name), position, documentIds: [n.f.id] });
  }
  return { units, unplaced };
}

// ── Opslaan (beheer) ─────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Controleert een nieuwe leerlijn van de docent.
 * body: { units: [{ key, title, position }], assignments: [{ documentId, unitKey }] }
 * Posities worden genormaliseerd naar 1, 2, 3, … (gelijke posities blijven gelijk).
 */
export function parseLeerlijnInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.units) || !Array.isArray(b.assignments)) {
    return { ok: false, status: 400, body: { error: 'Ongeldige leerlijn' } };
  }
  if (b.units.length > 200) return { ok: false, status: 400, body: { error: 'Te veel onderdelen' } };
  const keys = new Set();
  const units = [];
  for (const u of b.units) {
    const key = String(u?.key ?? '');
    const title = String(u?.title ?? '').trim().slice(0, 120);
    const pos = Number(u?.position);
    if (!key || keys.has(key)) return { ok: false, status: 400, body: { error: 'Ongeldige leerlijn' } };
    if (!title) return { ok: false, status: 400, body: { error: 'Elk onderdeel heeft een titel nodig' } };
    if (!Number.isFinite(pos) || pos < 1) return { ok: false, status: 400, body: { error: 'Ongeldige positie in de leerlijn' } };
    keys.add(key);
    units.push({ key, title, position: pos });
  }
  const distinct = [...new Set(units.map((u) => u.position))].sort((a, b) => a - b);
  for (const u of units) u.position = distinct.indexOf(u.position) + 1;
  const seenDocs = new Set();
  const assignments = [];
  for (const a of b.assignments) {
    const documentId = String(a?.documentId ?? '');
    const unitKey = String(a?.unitKey ?? '');
    if (!UUID_RE.test(documentId) || !keys.has(unitKey) || seenDocs.has(documentId)) {
      return { ok: false, status: 400, body: { error: 'Ongeldige koppeling van een bestand' } };
    }
    seenDocs.add(documentId);
    assignments.push({ documentId, unitKey });
  }
  return { ok: true, value: { units, assignments } };
}

// ── Leerlijn gebruiken ───────────────────────────────────────────────────────

/** Onderdeel van een begrip: het vroegste onderdeel van zijn brondocumenten. */
export function unitOfConcept(sourceDocumentIds, docUnit, unitById) {
  let best = null;
  for (const d of sourceDocumentIds || []) {
    const u = unitById.get(docUnit.get(d));
    if (u && (!best || u.position < best.position)) best = u;
  }
  return best;
}

/**
 * Anker voor deze vraag: de keuze van de student, anders het onderdeel met de
 * meeste overeenkomst onder de bronnen (som van de similarity per onderdeel).
 * sources: [{ documentId, similarity }]
 */
export function anchorUnit({ sources = [], explicitUnitId = null, docUnit, unitById }) {
  if (explicitUnitId && unitById.has(explicitUnitId)) return unitById.get(explicitUnitId);
  const weight = new Map();
  for (const s of sources) {
    const uid = docUnit.get(s?.documentId);
    if (!uid) continue;
    weight.set(uid, (weight.get(uid) || 0) + Math.max(0.01, Number(s?.similarity) || 0.01));
  }
  let best = null;
  let bestW = 0;
  for (const [uid, w] of weight) {
    if (w > bestW) { best = unitById.get(uid); bestW = w; }
  }
  return best || null;
}

/** Label van een onderdeel ten opzichte van het anker. */
export function relationTo(unit, anchor) {
  if (!anchor) return null;
  if (unit.id === anchor.id) return 'anchor';
  if (unit.position < anchor.position) return 'earlier';
  if (unit.position === anchor.position) return 'parallel';
  return 'later';
}

// Hoeveel oefening telt als "al geoefend"? Eén quizpoging of uitleg over een
// begrip uit het onderdeel telt 1 (een zwakke score 0,5); een tutorantwoord
// dat vooral op het onderdeel steunde 0,25. Vanaf 2 punten is het geoefend.
export const PRACTICE_THRESHOLD = 2;

/**
 * Punten per onderdeel uit de eigen gegevens van de student.
 * quiz: [{ topics: [naam], score_percentage }]; explanations: [{ concept_id, score }];
 * chatDocs: [[documentId, …] per tutorantwoord (bovenste bronnen)].
 */
export function practiceByUnit({ quiz = [], explanations = [], chatDocs = [], conceptUnitByName, conceptUnitById, docUnit }) {
  const pts = new Map();
  const add = (uid, n) => { if (uid) pts.set(uid, (pts.get(uid) || 0) + n); };
  for (const q of quiz) {
    const units = new Set((q.topics || []).map((n) => conceptUnitByName.get(String(n).toLowerCase().trim())).filter(Boolean));
    const w = Number(q.score_percentage) >= 50 ? 1 : 0.5;
    for (const u of units) add(u, w);
  }
  for (const e of explanations) {
    const total = Number(e?.score?.total);
    add(conceptUnitById.get(e.concept_id), Number.isFinite(total) && total < 60 ? 0.5 : 1);
  }
  for (const docs of chatDocs) {
    const units = new Set((docs || []).map((d) => docUnit.get(d)).filter(Boolean));
    for (const u of units) add(u, 0.25);
  }
  return pts;
}

export function practicedUnitIds(pts, threshold = PRACTICE_THRESHOLD) {
  return new Set([...pts].filter(([, n]) => n >= threshold).map(([u]) => u));
}

const RELATION_TEXT = {
  earlier: 'voorafgaand: mag je als bekend veronderstellen; verwijs er gerust naar terug',
  anchor: 'dit onderdeel: hier gaat de vraag vooral over',
  parallel: 'naast dit onderdeel: verwijs ernaar als dat helpt, maar veronderstel het niet als bekend',
  parallelPracticed: 'naast dit onderdeel; de student heeft dit al geoefend, dus je mag erop teruggrijpen',
  later: 'verderop in de leerlijn: niet als bekend veronderstellen',
  laterPracticed: 'verderop in de leerlijn, maar de student heeft dit al geoefend: je mag erop teruggrijpen als bekend',
};

/**
 * Blok voor de systeemprompt van de tutorchat (vakneutraal). Leeg zonder
 * leerlijn of zonder anker. sources: [{ title, documentId }] in de volgorde
 * van de bronnummers [1], [2], …
 */
export function buildLeerlijnBlock({ units, anchor, practiced = new Set(), sources = [], docUnit }) {
  if (!anchor || !Array.isArray(units) || units.length === 0) return '';
  const sorted = [...units].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const labelOf = (u) => {
    const rel = relationTo(u, anchor);
    if (rel === 'later' && practiced.has(u.id)) return RELATION_TEXT.laterPracticed;
    if (rel === 'parallel' && practiced.has(u.id)) return RELATION_TEXT.parallelPracticed;
    return RELATION_TEXT[rel];
  };
  const lines = sorted.slice(0, 40).map((u) => `${u.position}. ${u.title} — ${labelOf(u)}`);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const srcLines = sources
    .map((s, i) => {
      const u = unitById.get(docUnit.get(s?.documentId));
      return u ? `[${i + 1}] hoort bij "${u.title}"` : null;
    })
    .filter(Boolean);
  return [
    '',
    '',
    'Leerlijn van deze cursus (de volgorde waarin de stof is opgebouwd; een hoger nummer bouwt voort op wat ervoor komt, een gelijk nummer staat ernaast). Dit is geen planning in de tijd.',
    ...lines,
    srcLines.length ? `Bronnen per onderdeel: ${srcLines.join('; ')}.` : '',
    'Zo gebruik je de leerlijn:',
    '- Bouw voort op voorafgaande onderdelen en verwijs daar gerust naar terug ("zoals bij …").',
    '- Gebruik onderdelen die verderop liggen niet om iets uit te leggen; noem hooguit kort dat het later terugkomt. Uitzondering: onderdelen die de student al heeft geoefend (zie hierboven), daar mag je wel op teruggrijpen.',
    '- Vraagt de student zelf naar iets van verderop, leg het dan gewoon uit, aansluitend bij wat voorafgaat.',
    '- Loopt de student vast, kijk dan eerst of een begrip uit een voorafgaand onderdeel ontbreekt en vraag daarnaar.',
    '- Noem de leerlijn of deze labels niet letterlijk; gebruik ze alleen om je uitleg goed op te bouwen.',
  ].filter((l) => l !== null).join('\n');
}

// ── Data laden (server) ──────────────────────────────────────────────────────

/** Leerlijn van een cursus: { units, docUnit: Map(documentId → unitId), unitById }. */
export async function loadLeerlijn(db, courseId) {
  const [{ data: units, error }, { data: links }] = await Promise.all([
    db.from('course_units').select('id, title, position').eq('course_id', courseId).order('position'),
    db.from('course_unit_documents').select('document_id, unit_id').eq('course_id', courseId),
  ]);
  if (error) return { units: [], docUnit: new Map(), unitById: new Map(), available: false };
  return {
    units: units || [],
    docUnit: new Map((links || []).map((l) => [l.document_id, l.unit_id])),
    unitById: new Map((units || []).map((u) => [u.id, u])),
    available: true,
  };
}

/** Geoefende onderdelen van één student in één cursus (alleen zijn eigen gegevens). */
export async function loadPracticedUnits(db, { userId, courseId, leerlijn }) {
  const { docUnit, unitById } = leerlijn;
  if (unitById.size === 0) return new Set();
  const { data: concepts } = await db.from('concepts').select('id, name, source_document_ids').eq('course_id', courseId);
  const conceptUnitByName = new Map();
  const conceptUnitById = new Map();
  for (const c of concepts || []) {
    const u = unitOfConcept(c.source_document_ids, docUnit, unitById);
    if (!u) continue;
    conceptUnitByName.set(String(c.name).toLowerCase().trim(), u.id);
    conceptUnitById.set(c.id, u.id);
  }
  const conceptIds = [...conceptUnitById.keys()];
  const [{ data: quiz }, { data: explanations }, { data: convs }] = await Promise.all([
    db.from('quiz_attempts').select('topics, score_percentage').eq('student_id', userId).eq('course_id', courseId)
      .order('created_at', { ascending: false }).limit(200),
    conceptIds.length
      ? db.from('student_explanations').select('concept_id, score').eq('student_id', userId).in('concept_id', conceptIds.slice(0, 1000))
      : Promise.resolve({ data: [] }),
    db.from('conversations').select('id').eq('user_id', userId).eq('course_id', courseId).limit(200),
  ]);
  let chatDocs = [];
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length) {
    const { data: msgs } = await db.from('messages').select('retrieved_context').in('conversation_id', convIds)
      .eq('role', 'assistant').order('created_at', { ascending: false }).limit(300);
    chatDocs = (msgs || []).map((m) => (m.retrieved_context?.displaySources || []).slice(0, 3).map((s) => s?.documentId).filter(Boolean));
  }
  return practicedUnitIds(practiceByUnit({ quiz: quiz || [], explanations: explanations || [], chatDocs, conceptUnitByName, conceptUnitById, docUnit }));
}

// ── Routes ───────────────────────────────────────────────────────────────────
/**
 * GET  /api/courses/:courseId/leerlijn               onderdelen + koppeling (leden van de cursus)
 * GET  /api/admin/courses/:courseId/leerlijn/proposal voorstel uit bestandsnamen (staf)
 * PUT  /api/admin/courses/:courseId/leerlijn          opslaan (staf); { units, assignments }
 */
export function registerCourseUnitRoutes(app, deps) {
  const { supabaseAdmin, requireAuthUser, userHasCourseAccess, isStaffForCourse, courseMaterialDocuments, onChanged } = deps;
  const db = () => supabaseAdmin;

  app.get('/api/courses/:courseId/leerlijn', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    const l = await loadLeerlijn(db(), courseId);
    return res.json({
      available: l.available,
      units: l.units,
      documents: [...l.docUnit].map(([documentId, unitId]) => ({ documentId, unitId })),
    });
  });

  app.get('/api/admin/courses/:courseId/leerlijn/proposal', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Alleen docenten van deze cursus' });
    const docs = await courseMaterialDocuments(courseId);
    return res.json(proposeUnits(docs));
  });

  app.put('/api/admin/courses/:courseId/leerlijn', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Alleen docenten van deze cursus' });
    const parsed = parseLeerlijnInput(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
    const allowed = new Set((await courseMaterialDocuments(courseId)).map((d) => d.id));
    if (parsed.value.assignments.some((a) => !allowed.has(a.documentId))) {
      return res.status(400).json({ error: 'Een bestand hoort niet bij de leerstof van deze cursus' });
    }
    try {
      // Vervang de hele leerlijn: oude onderdelen (en hun koppelingen) weg, nieuwe erin.
      const { error: delErr } = await db().from('course_units').delete().eq('course_id', courseId);
      if (delErr) throw delErr;
      const keyToId = new Map();
      if (parsed.value.units.length) {
        const { data: ins, error: insErr } = await db().from('course_units')
          .insert(parsed.value.units.map((u) => ({ course_id: courseId, title: u.title, position: u.position })))
          .select('id, title, position');
        if (insErr) throw insErr;
        parsed.value.units.forEach((u, i) => keyToId.set(u.key, ins[i].id));
      }
      if (parsed.value.assignments.length) {
        const { error: linkErr } = await db().from('course_unit_documents').insert(parsed.value.assignments.map((a) => ({
          course_id: courseId, document_id: a.documentId, unit_id: keyToId.get(a.unitKey),
        })));
        if (linkErr) throw linkErr;
      }
      onChanged?.(courseId);
      console.log(`[leerlijn] Cursus ${courseId}: ${parsed.value.units.length} onderdelen, ${parsed.value.assignments.length} bestanden`);
      return res.json({ ok: true });
    } catch (err) {
      const missing = /course_unit/.test(err?.message || '') && /(does not exist|schema cache)/i.test(err?.message || '');
      return res.status(missing ? 503 : 500).json({ error: missing ? 'De tabellen voor de leerlijn ontbreken — pas de migratie eerst toe.' : (err?.message || 'Opslaan mislukt') });
    }
  });
}
