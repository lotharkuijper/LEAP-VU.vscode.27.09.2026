// Analytics — geaggregeerde inzichten over het gebruik van LEAP (2026-10-09).
//
// Een LOSSE module. Alles staat in deze map, plus:
//   server/index.js                       1 import + 1 aanroep installAnalytics(…)
//   src/services/llm.service.ts           `purpose: 'tutor_chat'` in sendChatMessage
//   src/features/analytics/               het tabblad "Analyse"
//   src/pages/AdminPage.tsx               tabblad 'analytics' (zoek op "analytics")
//   server/designAssistant.js             ADMIN_SECTIONS-regel 'analytics'
//   src/help/helpTopics.ts                'analytics.thermometer', 'analytics.platform'
//   src/i18n/locales/*.json               sleutels analytics.*, admin.tabs.analytics, help.analytics.*
//   supabase/migrations/20261009100000_analytics_counters.sql (+ rollback-script)
// Verwijderen = die regels/bestanden weghalen en het rollback-script draaien.
//
// Privacy: de tabel analytics_counters bevat geen gebruikers; quizcijfers
// worden live uit quiz_attempts berekend en alleen getoond bij ≥ K_MIN
// studenten. Docenten zien alleen hun eigen cursus; het platformoverzicht
// is alleen voor beheerders.

import { createCollector, analyticsMiddleware, installFetchMeter } from './collector.js';
import {
  K_MIN, periodStart, buildConceptThermometer, weeklyQuizSeries, summarizeIngestion, summarizePlatform,
} from './aggregate.js';

const PAGE = 1000;

/** Alle rijen van een PostgREST-query, in pagina's van 1000. */
async function allRows(makeQuery, max = 50000) {
  const out = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Tellers lezen; ontbreekt de tabel nog (migratie niet toegepast), dan leeg. */
async function counterRows(makeQuery) {
  try { return { rows: await allRows(makeQuery), available: true }; } catch { return { rows: [], available: false }; }
}

export function installAnalytics(app, deps) {
  const { getDb, authUser, isStaffForCourse, isLeapAdmin, flushMs = 60000 } = deps;
  const db = () => getDb();

  const collector = createCollector({
    write: async (rows) => {
      const { error } = await db().rpc('analytics_bump', { rows });
      if (error) throw new Error(error.message);
    },
  });

  // Begrippen per cursus, 10 minuten in het geheugen (voor de chat-herkenning).
  const conceptCache = new Map();
  async function loadConcepts(courseId) {
    const cols = 'name, aliases, review_status';
    const [byCol, byMarker] = await Promise.all([
      db().from('concepts').select(cols).eq('course_id', courseId),
      db().from('concepts').select(cols).contains('key_points', [`course_id:${courseId}`]),
    ]);
    const seen = new Set();
    const out = [];
    for (const c of [...(byCol.data || []), ...(byMarker.data || [])]) {
      if (c.review_status === 'rejected' || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push({ name: c.name, aliases: c.aliases || [] });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }
  async function conceptsFor(courseId) {
    const hit = conceptCache.get(courseId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
    const list = await loadConcepts(courseId);
    conceptCache.set(courseId, { at: Date.now(), list });
    return list;
  }

  if (db()) {
    app.use(analyticsMiddleware(collector, { conceptsFor }));
    installFetchMeter(collector);
    const timer = setInterval(() => { collector.flush(); }, flushMs);
    timer.unref?.();
  }

  async function profileOf(userId) {
    const { data } = await db().from('profiles').select('role, email').eq('id', userId).maybeSingle();
    return data || null;
  }

  // ── Docent: begrippen-thermometer van één cursus ─────────────────────────
  app.get('/api/analytics/courses/:courseId/concepts', async (req, res) => {
    if (!db()) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId } = req.params;
    try {
      const profile = await profileOf(auth.user.id);
      if (!(await isStaffForCourse(auth.user, profile, courseId))) return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      await collector.flush();
      const since = periodStart(req.query.weeks);
      const [concepts, attempts, counters] = await Promise.all([
        loadConcepts(courseId),
        allRows(() => db().from('quiz_attempts')
          .select('student_id, topics, score_percentage, created_at')
          .eq('course_id', courseId).gte('created_at', since).order('created_at')),
        counterRows(() => db().from('analytics_counters')
          .select('kind, key, n, week').eq('course_id', courseId).gte('week', since)
          .in('kind', ['chat_evidence', 'chat_concept_hit', 'chat_concept_miss'])),
      ]);
      const result = buildConceptThermometer({ attempts, concepts, chatRows: counters.rows, k: K_MIN });
      const measuredSince = counters.rows.map(r => r.week).sort()[0] || null;
      return res.json({ since, measuredSince, countersAvailable: counters.available, ...result, weekly: weeklyQuizSeries(attempts, K_MIN) });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ── Beheerder: gezondheid en kosten van heel LEAP ────────────────────────
  app.get('/api/analytics/platform', async (req, res) => {
    if (!db()) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      if (!isLeapAdmin(await profileOf(auth.user.id))) return res.status(403).json({ error: 'Geen toegang' });
      await collector.flush();
      const since = periodStart(req.query.weeks);
      const [counters, courses, assignments, docs] = await Promise.all([
        counterRows(() => db().from('analytics_counters')
          .select('week, course_id, kind, key, n, total').gte('week', since)
          .in('kind', ['api', 'api_error', 'api_slow', 'tokens'])),
        allRows(() => db().from('courses').select('id, name, is_active').order('name')),
        allRows(() => db().from('course_folder_assignments').select('course_id, folder_id')),
        allRows(() => db().from('documents').select('id, folder_id, processing_status, total_chunks, file_size, file_type').not('folder_id', 'is', null)),
      ]);
      const names = Object.fromEntries(courses.map(c => [c.id, c.name]));
      const foldersByCourse = new Map();
      for (const a of assignments) {
        if (!foldersByCourse.has(a.course_id)) foldersByCourse.set(a.course_id, new Set());
        foldersByCourse.get(a.course_id).add(a.folder_id);
      }
      const ingestion = courses.map(c => {
        const folders = foldersByCourse.get(c.id) || new Set();
        return { courseId: c.id, name: c.name, active: c.is_active !== false, ...summarizeIngestion(docs.filter(d => folders.has(d.folder_id))) };
      }).filter(r => r.documents > 0 || r.active);
      return res.json({ since, countersAvailable: counters.available, ...summarizePlatform(counters.rows, names), ingestion });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return { collector };
}
