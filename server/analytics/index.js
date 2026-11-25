// Analytics — geaggregeerde inzichten over het gebruik van LEAP (2026-10-09).
//
// Een LOSSE module. Alles staat in deze map, plus:
//   server/index.js                       1 import + 1 aanroep installAnalytics(…)
//   src/services/llm.service.ts           `purpose: 'tutor_chat'` in sendChatMessage
//   src/features/analytics/               het tabblad "Analyse"
//   src/pages/AdminPage.tsx               tabblad 'analytics' (zoek op "analytics"); geeft de
//                                         leerniveaus mee als `levels` (bij verwijderen: daar
//                                         <LearningLevelsAdminTab /> los neerzetten)
//   server/system/designAssistant.js             ADMIN_SECTIONS-regel 'analytics'
//   src/help/helpTopics.ts                'analytics.thermometer', 'analytics.platform', 'analytics.usage', 'analytics.costs'
//   src/i18n/locales/*.json               sleutels analytics.*, admin.tabs.analytics, help.analytics.*
//   supabase/migrations/20261009100000_analytics_counters.sql (+ rollback-script)
//   supabase/migrations/20261125100000_analytics_daily.sql   (+ rollback-script)
// Verwijderen = die regels/bestanden weghalen en de rollback-scripts draaien.
//
// Privacy: de tabellen analytics_counters (per week) en analytics_daily (per
// dag) bevatten geen gebruikers. Wie actief was, wordt alleen in het geheugen
// ontdubbeld, en alleen voor gebruikers wiens login de server controleerde.
// Quiz- en uitlegcijfers worden live berekend; elk cijfer over studenten wordt
// verborgen onder K_MIN of op minder dan K_MIN na iedereen. Docenten zien alleen
// hun eigen cursus; kosten en het platformoverzicht zijn alleen voor beheerders.

import { createCollector, analyticsMiddleware, installFetchMeter } from './collector.js';
import {
  K_MIN, periodStart, weekStart, amsterdamDay, daysBetween, buildConceptThermometer, weeklyQuizSeries, summarizeIngestion, summarizePlatform,
  buildCourseUsage, explainPerConcept, summarizeAchievements, summarizeDaily, isUuid, splitForTables, weeksBetween,
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

  // Weektellers (bestaand) en dagtellers (2026-11-25). Ontbreekt de dagtabel nog
  // (migratie niet toegepast), dan lopen de weektellers gewoon door.
  let dailyPausedUntil = 0;
  const collector = createCollector({
    write: async (rows) => {
      const { weekly, daily } = splitForTables(rows);
      if (weekly.length) {
        const { error } = await db().rpc('analytics_bump', { rows: weekly });
        if (error) throw new Error(error.message);
      }
      if (!daily.length || Date.now() < dailyPausedUntil) return;
      const { error: dayErr } = await db().rpc('analytics_bump_daily', { rows: daily });
      if (dayErr) {
        dailyPausedUntil = Date.now() + 10 * 60 * 1000;
        console.warn(`[analytics] dagtellers niet opgeslagen (${dayErr.message}); 10 min pauze.`);
      }
    },
  });

  // Rol en cursus van een gebruiker voor het tellen van activiteit (10 min in het
  // geheugen). Alleen 'student' in die cursus telt als student.
  const whoCache = new Map();
  async function who(userId, courseId) {
    const key = `${userId}|${courseId || ''}`;
    const hit = whoCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    let cid = courseId || null;
    const { data: profile } = await db().from('profiles').select('role, last_active_course_id').eq('id', userId).maybeSingle();
    if (!cid) cid = profile?.last_active_course_id || null;
    let role = profile?.role || null;
    if (cid) {
      const { data: m } = await db().from('course_members').select('member_role').eq('user_id', userId).eq('course_id', cid).maybeSingle();
      if (m?.member_role) role = m.member_role;
      else if (role === 'student') cid = null; // geen lid van die cursus: niet aan de cursus toeschrijven
    }
    const value = { courseId: cid, role };
    if (whoCache.size > 5000) whoCache.clear();
    whoCache.set(key, { at: Date.now(), value });
    return value;
  }

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
    // Login gecontroleerd door de server (authUser, met tussengeheugen); nooit een ongecontroleerd token.
    const verifyUser = async (req) => (await authUser(req)).user?.id || null;
    app.use(analyticsMiddleware(collector, { conceptsFor, who, verifyUser }));
    installFetchMeter(collector);
    const timer = setInterval(() => { collector.flush(); }, flushMs);
    timer.unref?.();
  }

  async function profileOf(userId) {
    const { data } = await db().from('profiles').select('role, email').eq('id', userId).maybeSingle();
    return data || null;
  }

  // Periode van een cursusoverzicht: ?weeks=, maar sinds een nieuwe editie
  // (course_editions) alleen de huidige jaargang, tenzij ?edition=all.
  async function courseSince(courseId, query) {
    const period = periodStart(query.weeks);
    let editionStart = null;
    if (query.edition !== 'all') {
      try {
        const { data: ed } = await db().from('course_editions').select('started_at').eq('course_id', courseId)
          .order('started_at', { ascending: false }).limit(1);
        editionStart = ed?.[0]?.started_at || null;
      } catch { /* geen edities (of tabel ontbreekt): hele periode */ }
    }
    const later = editionStart && editionStart > period;
    return {
      since: later ? editionStart : period,
      sinceWeek: later ? weekStart(new Date(editionStart)) : period,
      sinceDay: later ? amsterdamDay(new Date(editionStart)) : period,
      editionStart,
    };
  }

  // Uitleg van studenten bij begrippen van deze cursus (alleen begrip, score, student-id om te ontdubbelen).
  async function explainForCourse(courseId, since) {
    const { data: cs } = await db().from('concepts').select('id, name').eq('course_id', courseId);
    const names = Object.fromEntries((cs || []).map((c) => [c.id, c.name]));
    const ids = Object.keys(names);
    if (!ids.length) return { rows: [], names };
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) {
      const part = await allRows(() => db().from('student_explanations')
        .select('student_id, concept_id, score, created_at').in('concept_id', ids.slice(i, i + 200)).gte('created_at', since).order('created_at'));
      for (const r of part) rows.push({ student_id: r.student_id, concept_id: r.concept_id, score: typeof r.score?.total === 'number' ? r.score.total : null });
    }
    return { rows, names };
  }

  // ── Docent: hoe gebruiken studenten de cursus (per dag en per week) ───────
  app.get('/api/analytics/courses/:courseId/usage', async (req, res) => {
    if (!db()) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId } = req.params;
    try {
      const profile = await profileOf(auth.user.id);
      if (!(await isStaffForCourse(auth.user, profile, courseId))) return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      await collector.flush();
      const { sinceWeek, sinceDay, since, editionStart } = await courseSince(courseId, req.query);
      const days = daysBetween(sinceDay, amsterdamDay());
      const weeks = weeksBetween(sinceWeek, amsterdamDay());
      const [daily, weekly, members, projects, achievements] = await Promise.all([
        counterRows(() => db().from('analytics_daily').select('day, kind, key, n').eq('course_id', courseId).gte('day', sinceDay)
          .in('kind', ['active_students'])),
        counterRows(() => db().from('analytics_counters').select('week, kind, key, n').eq('course_id', courseId).gte('week', sinceWeek)
          .in('kind', ['active_students_week', 'active_part', 'part_actions', 'active_group'])),
        allRows(() => db().from('course_members').select('user_id').eq('course_id', courseId).eq('member_role', 'student')),
        allRows(() => db().from('projects').select('id').eq('course_id', courseId)),
        allRows(() => db().from('student_achievements').select('user_id, kind, earned_at').eq('course_id', courseId).gte('earned_at', since)),
      ]);
      const projectIds = projects.map((p) => p.id);
      const groups = projectIds.length
        ? (await allRows(() => db().from('project_groups').select('id').in('project_id', projectIds))).length
        : 0;
      const enrolled = members.length;
      return res.json({
        since, editionStart, dailyAvailable: daily.available,
        measuredSince: daily.rows.map((r) => r.day).sort()[0] || null,
        ...buildCourseUsage({ dailyRows: daily.rows, weeklyRows: weekly.rows, days, weeks, enrolled, groups, k: K_MIN }),
        achievements: summarizeAchievements(achievements, { enrolled, weeks, k: K_MIN }),
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

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
      const { since, sinceWeek, editionStart } = await courseSince(courseId, req.query);
      const [concepts, attempts, counters, explainRows] = await Promise.all([
        loadConcepts(courseId),
        allRows(() => db().from('quiz_attempts')
          .select('student_id, topics, score_percentage, created_at')
          .eq('course_id', courseId).gte('created_at', since).order('created_at')),
        counterRows(() => db().from('analytics_counters')
          .select('kind, key, n, week').eq('course_id', courseId).gte('week', sinceWeek)
          .in('kind', ['chat_evidence', 'chat_concept_hit', 'chat_concept_miss', 'chat_attachment'])),
        explainForCourse(courseId, since),
      ]);
      const result = buildConceptThermometer({ attempts, concepts, chatRows: counters.rows, k: K_MIN });
      const measuredSince = counters.rows.map(r => r.week).sort()[0] || null;
      // Bijlagen in de chat: alleen aantallen per soort (geen namen, geen inhoud).
      const attachments = { image: 0, file: 0 };
      for (const r of counters.rows) if (r.kind === 'chat_attachment' && r.key in attachments) attachments[r.key] += Number(r.n || 0);
      return res.json({
        since, editionStart, measuredSince, countersAvailable: counters.available, ...result, attachments,
        weekly: weeklyQuizSeries(attempts, K_MIN),
        // Ik leg uit per begrip (2026-11-25): aantal studenten en gemiddelde score, onder k verborgen.
        explain: explainPerConcept(explainRows.rows, explainRows.names, K_MIN),
      });
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
      const courseFilter = isUuid(req.query.courseId) ? req.query.courseId : null;
      const [counters, dailyCounters, courses, assignments, docs] = await Promise.all([
        counterRows(() => db().from('analytics_counters')
          .select('week, course_id, kind, key, n, total').gte('week', since)
          .in('kind', ['api', 'api_error', 'api_slow', 'tokens'])),
        counterRows(() => db().from('analytics_daily')
          .select('day, course_id, kind, key, n, total').gte('day', since)
          .in('kind', ['tokens', 'active_users'])),
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
      // Per dag (2026-11-25): tokens en actieve gebruikers, voor heel LEAP of één cursus.
      const daily = summarizeDaily(dailyCounters.rows, { days: daysBetween(since, amsterdamDay()), courseId: courseFilter, courseNames: names });
      return res.json({
        since, countersAvailable: counters.available, ...summarizePlatform(counters.rows), ingestion,
        daily: { ...daily, available: dailyCounters.available, courseId: courseFilter, measuredSince: dailyCounters.rows.map((r) => r.day).sort()[0] || null },
        courses: courses.map((c) => ({ id: c.id, name: c.name })),
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return { collector };
}
