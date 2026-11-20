// Routes voor beeldoefeningen, docentkant (2026-11-20). Elke route: alleen een
// docent van déze cursus of een admin (isStaffForCourse). Studenten hebben hier
// niets: de beschrijvingen en kenmerken zijn de antwoordsleutel.
import { randomUUID } from 'node:crypto';
import { isStaffForCourse, requireAuthUser } from '../lib/auth.js';
import { AZURE_CHAT_READY, LLM_NOT_CONFIGURED_MSG } from '../lib/azureOpenai.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { DESCRIPTION_DOC_EXT, MAX_DESCRIPTION_DOC_BYTES, extractDescriptionText } from './documentText.js';
import { UUID_RE } from './common.js';
import { llmJson } from './llm.js';
import {
  addPhoto, applyDescriptionText, confirmExercises, deleteExercise, generateFeatures,
  listExercises, saveFeatures, setFeatureCore, suggestMatches, updateExercise,
} from './service.js';

// Kenmerken maken loopt op de achtergrond, twee tegelijk; de docent ziet de status.
// Een foto staat hooguit één keer in de wachtrij, en de wachtrij heeft een plafond:
// wat er niet meer bij past, krijgt status 'failed' (de docent kan opnieuw proberen).
const MAX_QUEUE = 1000;
const queue = [];
const queued = new Set();
let running = 0;
function queueFeatures(ids) {
  const dropped = [];
  for (const id of ids) {
    if (queued.has(id)) continue;
    if (queued.size >= MAX_QUEUE) { dropped.push(id); continue; }
    queued.add(id);
    queue.push(id);
  }
  if (dropped.length) {
    supabaseAdmin.from('image_exercises').update({ features_status: 'failed' }).in('id', dropped)
      .then(({ error }) => { if (error) console.warn('[image-exercises] wachtrij vol:', error.message); });
  }
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const id = queue.shift();
    running++;
    generateFeatures(supabaseAdmin, (m) => llmJson(m), id)
      .catch((err) => console.error('[image-exercises] kenmerken mislukt:', err.message))
      .finally(() => { running--; queued.delete(id); pump(); });
  }
}

// Een voorstel op het oog kost per foto een beeldaanroep: per cursus één tegelijk
// en hooguit één per halve minuut.
const SUGGEST_GAP_MS = 30_000;
const lastSuggest = new Map();


export function registerImageExerciseRoutes(app) {
  const base = '/api/admin/image-exercises/:courseId';

  // Wat na een herstart nog op 'bezig' stond, wordt nooit meer afgemaakt: zet het
  // op 'mislukt', zodat de docent het opnieuw kan laten maken.
  supabaseAdmin?.from('image_exercises').update({ features_status: 'failed' }).eq('features_status', 'pending')
    .then(({ error }) => { if (error) console.warn('[image-exercises] status na herstart:', error.message); });

  async function staff(req, res) {
    const { courseId, id, featureId } = req.params;
    if (![courseId, id, featureId].every((v) => v === undefined || UUID_RE.test(v))) {
      res.status(400).json({ error: 'Ongeldige aanvraag' });
      return null;
    }
    const auth = await requireAuthUser(req, res);
    if (!auth) return null;
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      return null;
    }
    return auth;
  }

  const send = (res, err, label) => {
    if (err?.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error(`[image-exercises] ${label}:`, err?.message || err);
    return res.status(500).json({ error: 'Er ging iets mis bij de beeldoefeningen.' });
  };

  app.get(base, async (req, res) => {
    if (!(await staff(req, res))) return;
    try { return res.json({ exercises: await listExercises(supabaseAdmin, req.params.courseId) }); } catch (err) { return send(res, err, 'lijst'); }
  });

  app.post(`${base}/photos`, async (req, res) => {
    const auth = await staff(req, res);
    if (!auth) return;
    const { filename, data } = req.body || {};
    if (!filename || typeof data !== 'string') return res.status(400).json({ error: 'filename en data zijn verplicht' });
    try {
      const r = await addPhoto(supabaseAdmin, { courseId: req.params.courseId, userId: auth.user.id, filename, buffer: Buffer.from(data, 'base64'), newId: randomUUID });
      return res.json(r);
    } catch (err) { return send(res, err, 'foto'); }
  });

  // Beschrijvingen: een document (base64) of geplakte tekst.
  app.post(`${base}/descriptions`, async (req, res) => {
    if (!(await staff(req, res))) return;
    const { filename, data, text, exerciseId } = req.body || {};
    if (exerciseId !== undefined && exerciseId !== null && !UUID_RE.test(String(exerciseId))) return res.status(400).json({ error: 'Ongeldige aanvraag' });
    try {
      let content = typeof text === 'string' ? text : '';
      if (!content && typeof data === 'string') {
        const ext = String(filename || '').split('.').pop().toLowerCase();
        if (!DESCRIPTION_DOC_EXT.includes(ext)) return res.status(400).json({ error: 'Dit bestandstype kan niet als beschrijving worden gelezen (docx, pdf, txt, md).', code: 'badDescriptionType' });
        const buf = Buffer.from(data, 'base64');
        if (buf.length > MAX_DESCRIPTION_DOC_BYTES) return res.status(400).json({ error: 'Het document is te groot (hooguit 10 MB).', code: 'docTooLarge' });
        content = await extractDescriptionText(buf, ext);
      }
      return res.json(await applyDescriptionText(supabaseAdmin, {
        courseId: req.params.courseId, text: content, filename: typeof filename === 'string' ? filename : '', exerciseId: exerciseId || null,
      }));
    } catch (err) { return send(res, err, 'beschrijvingen'); }
  });

  app.post(`${base}/suggest`, async (req, res) => {
    if (!(await staff(req, res))) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    const key = req.params.courseId;
    const last = lastSuggest.get(key);
    if (last === 'busy' || (typeof last === 'number' && Date.now() - last < SUGGEST_GAP_MS)) {
      return res.status(429).json({ error: 'LEAP is net bezig geweest met een voorstel. Probeer het over een halve minuut opnieuw.', code: 'suggestBusy' });
    }
    lastSuggest.set(key, 'busy');
    try {
      return res.json(await suggestMatches(supabaseAdmin, (m) => llmJson(m, 300), { courseId: req.params.courseId, sections: req.body?.sections }));
    } catch (err) {
      return send(res, err, 'voorstel');
    } finally {
      lastSuggest.set(key, Date.now());
    }
  });

  app.post(`${base}/confirm`, async (req, res) => {
    if (!(await staff(req, res))) return;
    try {
      const r = await confirmExercises(supabaseAdmin, { courseId: req.params.courseId, ids: req.body?.ids });
      if (r.confirmed.length && AZURE_CHAT_READY) queueFeatures(r.confirmed);
      return res.json(r);
    } catch (err) { return send(res, err, 'bevestigen'); }
  });

  app.patch(`${base}/:id`, async (req, res) => {
    if (!(await staff(req, res))) return;
    const { description, matchSource, depth, countDisplay } = req.body || {};
    try { return res.json(await updateExercise(supabaseAdmin, { courseId: req.params.courseId, id: req.params.id, description, matchSource, depth, countDisplay })); } catch (err) { return send(res, err, 'aanpassen'); }
  });

  app.post(`${base}/:id/regenerate`, async (req, res) => {
    if (!(await staff(req, res))) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    try {
      const { confirmed } = await confirmExercises(supabaseAdmin, { courseId: req.params.courseId, ids: [req.params.id] });
      if (!confirmed.length) return res.status(400).json({ error: 'Deze foto heeft nog geen beschrijving.', code: 'noDescription' });
      queueFeatures(confirmed);
      return res.json({ ok: true });
    } catch (err) { return send(res, err, 'opnieuw'); }
  });

  app.put(`${base}/:id/features`, async (req, res) => {
    if (!(await staff(req, res))) return;
    try { return res.json(await saveFeatures(supabaseAdmin, { courseId: req.params.courseId, id: req.params.id, features: req.body?.features })); } catch (err) { return send(res, err, 'kenmerken opslaan'); }
  });

  app.patch(`${base}/features/:featureId`, async (req, res) => {
    if (!(await staff(req, res))) return;
    try { return res.json(await setFeatureCore(supabaseAdmin, { courseId: req.params.courseId, featureId: req.params.featureId, isCore: req.body?.isCore })); } catch (err) { return send(res, err, 'kenmerk'); }
  });

  app.delete(`${base}/:id`, async (req, res) => {
    if (!(await staff(req, res))) return;
    try { return res.json(await deleteExercise(supabaseAdmin, { courseId: req.params.courseId, id: req.params.id })); } catch (err) { return send(res, err, 'verwijderen'); }
  });
}
