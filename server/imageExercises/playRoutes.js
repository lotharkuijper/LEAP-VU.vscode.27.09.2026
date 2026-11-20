// Routes voor het speelbord van beeldoefeningen, studentkant (2026-11-21). Iedereen
// met toegang tot de cursus (studenten, en docenten om te testen), zolang Ik leg uit
// aan staat. Elke poging is van de ingelogde gebruiker zelf; de antwoordsleutel
// blijft op de server (zie playService.js).
import { requireAuthUser, userHasCourseAccess } from '../lib/auth.js';
import { AZURE_CHAT_READY, LLM_NOT_CONFIGURED_MSG } from '../lib/azureOpenai.js';
import { rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { llmJson } from './llm.js';
import { UUID_RE } from './common.js';
import { answer, finish, hint, listForStudent, restartAttempt, startAttempt } from './playService.js';

// Rem op de kosten: hooguit zoveel antwoorden, hints en terugblikken (elk een
// aanroep van het taalmodel) per gebruiker per tien minuten.
export const PLAY_RATE = { MAX_CALLS: 60, WINDOW_MS: 10 * 60_000 };
const calls = new Map();
export function overRate(userId, at = Date.now()) {
  const recent = (calls.get(userId) || []).filter((t) => at - t < PLAY_RATE.WINDOW_MS);
  if (recent.length >= PLAY_RATE.MAX_CALLS) { calls.set(userId, recent); return true; }
  recent.push(at);
  calls.set(userId, recent);
  return false;
}

export function registerImageExercisePlayRoutes(app) {
  const base = '/api/image-exercises/:courseId';

  async function member(req, res) {
    const { courseId, id } = req.params;
    if (![courseId, id].every((v) => v === undefined || UUID_RE.test(v))) {
      res.status(400).json({ error: 'Ongeldige aanvraag' });
      return null;
    }
    const auth = await requireAuthUser(req, res);
    if (!auth) return null;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      return null;
    }
    if (await rejectIfFeatureOff(res, auth.user, auth.profile, courseId, 'explain')) return null;
    return auth;
  }

  const send = (res, err, label) => {
    if (err?.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error(`[image-play] ${label}:`, err?.message || err);
    return res.status(500).json({ error: 'Er ging iets mis bij de beeldoefening.' });
  };

  const ctx = (req, auth) => ({
    courseId: req.params.courseId,
    userId: auth.user.id,
    id: req.params.id,
    languageInstruction: buildLanguageInstruction(req.get('x-leap-lang'), { json: true }),
  });
  const llm = (maxTokens) => (messages) => llmJson(messages, maxTokens);
  const limited = (res, auth) => {
    if (!overRate(auth.user.id)) return false;
    res.status(429).json({ error: 'Even pauze: je hebt in korte tijd veel antwoorden gegeven. Probeer het over een paar minuten opnieuw.', code: 'slowDown' });
    return true;
  };

  app.get(base, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    try { return res.json({ exercises: await listForStudent(supabaseAdmin, { courseId: req.params.courseId, userId: auth.user.id }) }); } catch (err) { return send(res, err, 'lijst'); }
  });

  app.post(`${base}/:id/start`, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    try { return res.json(await startAttempt(supabaseAdmin, ctx(req, auth))); } catch (err) { return send(res, err, 'start'); }
  });

  app.post(`${base}/:id/restart`, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    if (limited(res, auth)) return;
    try { return res.json(await restartAttempt(supabaseAdmin, ctx(req, auth))); } catch (err) { return send(res, err, 'opnieuw'); }
  });

  app.post(`${base}/:id/answer`, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    if (limited(res, auth)) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    try { return res.json(await answer(supabaseAdmin, llm(2000), { ...ctx(req, auth), text: req.body?.text })); } catch (err) { return send(res, err, 'antwoord'); }
  });

  app.post(`${base}/:id/hint`, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    if (limited(res, auth)) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    try { return res.json(await hint(supabaseAdmin, llm(400), ctx(req, auth))); } catch (err) { return send(res, err, 'hint'); }
  });

  app.post(`${base}/:id/finish`, async (req, res) => {
    const auth = await member(req, res);
    if (!auth) return;
    if (limited(res, auth)) return;
    try { return res.json(await finish(supabaseAdmin, llm(500), ctx(req, auth))); } catch (err) { return send(res, err, 'afronden'); }
  });
}
