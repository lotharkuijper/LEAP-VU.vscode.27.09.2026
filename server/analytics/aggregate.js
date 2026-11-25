// Analytics — pure rekenregels (geen database, geen netwerk; zie de tests in
// server/__tests__/analytics.test.js).
//
// Privacyregels die hier worden afgedwongen:
//  * K_MIN: een cijfer dat op minder dan K_MIN verschillende studenten berust,
//    wordt niet getoond (null + `suppressed: true`). Anders is "gemiddelde
//    score 34%" bij één student gewoon diens cijfer.
//  * De uitvoer bevat nooit een user-id, naam of de tekst van een vraag.

export const K_MIN = 5;

/** Maandag (UTC) van de week waarin `date` valt, als 'YYYY-MM-DD'. */
export function weekStart(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // ma = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Kalenderdag in Amsterdamse tijd, als 'YYYY-MM-DD' (een studiedag loopt niet op UTC). */
export function amsterdamDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Alle dagen van `from` t/m `to` ('YYYY-MM-DD'), voor grafieken zonder gaten. */
export function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < 400; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Onderdeel voor studenten bij een API-onderdeel (featureOf), voor "welke
 * onderdelen gebruiken studenten". null = geen studentonderdeel.
 */
export const STUDENT_PARTS = Object.freeze({
  chat: 'chat', 'chat-attachments': 'chat', explain: 'explain', 'image-exercises': 'image',
  quiz: 'quiz', projects: 'projects', studiecafe: 'studiecafe', journal: 'journal',
});
export function studentPartOf(feature) {
  return STUDENT_PARTS[feature] || null;
}

// Welke tellers in welke tabel: per dag alleen wat per dag gelezen wordt; de
// dagelijks ontdubbelde tellers horen niet in de weektabel (een week is geen som van dagen).
const DAILY_KINDS = new Set(['tokens', 'active_users', 'active_students']);
const DAY_ONLY_KINDS = new Set(['active_users', 'active_students']);
/** Pure: rijen uit de buffer → { weekly, daily } voor analytics_counters en analytics_daily. */
export function splitForTables(rows = []) {
  return {
    weekly: rows.filter((r) => !DAY_ONLY_KINDS.has(r.kind)),
    daily: rows.filter((r) => DAILY_KINDS.has(r.kind)),
  };
}

/** Alle maandagen van `from` t/m de week van `to` ('YYYY-MM-DD'). */
export function weeksBetween(from, to) {
  const out = [];
  const d = new Date(`${weekStart(new Date(`${from}T00:00:00Z`))}T00:00:00Z`);
  const end = weekStart(new Date(`${to}T00:00:00Z`));
  for (let i = 0; i < 60 && d.toISOString().slice(0, 10) <= end; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/** Groep voor het tokenverbruik (beheer): wat studenten doen, voorbereiding door docenten, of de rest. */
export function tokenGroupOf(feature) {
  if (!feature) return 'other';
  if (studentPartOf(feature)) return 'students';
  if (feature === 'background') return 'background';
  if (feature.startsWith('admin/')) return 'teachers';
  return 'other';
}

/** Begin van de periode: de maandag van `weeks` weken geleden (deze week telt mee). */
export function periodStart(weeks, now = new Date()) {
  const w = Math.max(1, Math.min(52, Number(weeks) || 8));
  const d = new Date(`${weekStart(now)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * (w - 1));
  return d.toISOString().slice(0, 10);
}

/** Kleine letters, zonder accenten en leestekens; voor het herkennen van begrippen. */
export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Welke begrippen (naam of alias) komen in een tekst voor, als heel woord of
 * woordgroep? Namen korter dan 3 tekens tellen niet (te veel valse treffers).
 * Geeft de namen van de begrippen terug (niet de tekst).
 */
export function matchConcepts(text, concepts) {
  const hay = ` ${normalizeText(text)} `;
  if (hay.trim() === '') return [];
  const out = [];
  for (const c of concepts || []) {
    const names = [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]
      .map(normalizeText).filter(n => n.length >= 3);
    if (names.some(n => hay.includes(` ${n} `))) out.push(c.name);
  }
  return out;
}

/** Hoort een quiz-onderwerp (zoals opgeslagen in quiz_attempts.topics) bij dit begrip? */
function topicMatches(topic, concept) {
  const t = normalizeText(topic);
  if (!t) return false;
  return [concept.name, ...(concept.aliases || [])].some(n => normalizeText(n) === t);
}

/**
 * Gemiddelde waarin elke student even zwaar weegt: eerst per student, dan
 * over de studenten. Zo kan één student met veel pogingen (of verzonnen
 * pogingen) het cijfer niet domineren. Geeft { students, attempts, avg }.
 */
export function perStudentAverage(rows) {
  const by = new Map();
  for (const a of rows) {
    const cur = by.get(a.student_id) || { sum: 0, n: 0 };
    cur.sum += a.score_percentage; cur.n++;
    by.set(a.student_id, cur);
  }
  const means = [...by.values()].map(v => v.sum / v.n);
  return {
    students: by.size,
    attempts: rows.length,
    avg: means.length ? Math.round(means.reduce((x, y) => x + y, 0) / means.length) : null,
  };
}

/**
 * Begrippen-thermometer voor één cursus.
 *  attempts: [{ student_id, topics: string[], score_percentage }]
 *  concepts: [{ name, aliases }]
 *  chatRows: tellers [{ kind, key, n }] met kind 'chat_concept_hit' / 'chat_concept_miss'
 *            (key = begripnaam) en 'chat_evidence' (key = 'hit' | 'miss')
 * De student_id's worden alleen geteld, nooit teruggegeven.
 */
export function buildConceptThermometer({ attempts = [], concepts = [], chatRows = [], k = K_MIN }) {
  const perConcept = concepts.map(c => {
    const rows = attempts.filter(a => Array.isArray(a.topics) && a.topics.some(t => topicMatches(t, c))
      && typeof a.score_percentage === 'number');
    const s = perStudentAverage(rows);
    const enough = s.students >= k;
    const chat = (kind) => chatRows.filter(r => r.kind === kind && r.key === c.name).reduce((s, r) => s + Number(r.n || 0), 0);
    const asked = chat('chat_concept_hit') + chat('chat_concept_miss');
    const misses = chat('chat_concept_miss');
    return {
      name: c.name,
      quiz: {
        attempts: enough ? s.attempts : null,
        avgScore: enough ? scoreBand(s.avg) : null,
        suppressed: s.students > 0 && !enough,
      },
      chat: { asked, misses },
    };
  });

  const ev = (key) => chatRows.filter(r => r.kind === 'chat_evidence' && r.key === key).reduce((s, r) => s + Number(r.n || 0), 0);
  const course = perStudentAverage(attempts.filter(a => typeof a.score_percentage === 'number'));
  const courseEnough = course.students >= k;

  return {
    k,
    quiz: {
      attempts: courseEnough ? course.attempts : null,
      avgScore: courseEnough ? scoreBand(course.avg) : null,
      suppressed: course.students > 0 && !courseEnough,
    },
    chat: { hit: ev('hit'), miss: ev('miss') },
    concepts: perConcept,
  };
}

/** Verloop per week voor de cursus (gemiddelde quizscore), met k-drempel per week. */
export function weeklyQuizSeries(attempts = [], k = K_MIN) {
  const byWeek = new Map();
  for (const a of attempts) {
    if (typeof a.score_percentage !== 'number' || !a.created_at) continue;
    const w = weekStart(new Date(a.created_at));
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(a);
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rows]) => {
    const v = perStudentAverage(rows);
    return v.students >= k
      ? { week, avgScore: scoreBand(v.avg), attempts: v.attempts }
      : { week, avgScore: null, attempts: null, suppressed: true };
  });
}

/** Telt ingest-problemen in één cursus (zelfde regels als "Klaar voor studenten"). */
export function summarizeIngestion(docs = []) {
  const s = { documents: docs.length, failed: 0, busy: 0, noChunks: 0, singleGiantChunk: 0, bytes: 0, chunks: 0 };
  for (const d of docs) {
    s.bytes += Number(d.file_size || 0);
    s.chunks += Number(d.total_chunks || 0);
    if (d.processing_status === 'failed') s.failed++;
    else if (d.processing_status === 'pending' || d.processing_status === 'processing') s.busy++;
    else if (d.processing_status === 'completed') {
      if (d.file_type !== 'web' && Number(d.total_chunks || 0) === 0) s.noChunks++;
      if (d.file_type !== 'web' && Number(d.total_chunks || 0) === 1 && Number(d.file_size || 0) > 50000) s.singleGiantChunk++;
    }
  }
  return s;
}

/**
 * Tellers samenvatten tot het platformoverzicht.
 * rows: [{ week, course_id, kind, key, n, total }]
 *  kind 'api'       key = onderdeel, n = verzoeken, total = ms
 *  kind 'api_error' key = onderdeel, n = serverfouten (5xx)
 *  kind 'api_slow'  key = onderdeel, n = verzoeken > 10 s
 *  kind 'tokens'    key = onderdeel, n = aanroepen taalmodel, total = tokens
 */
export function summarizePlatform(rows = []) {
  const parts = new Map();
  const part = (key) => {
    if (!parts.has(key)) parts.set(key, { key, requests: 0, errors: 0, slow: 0, totalMs: 0, llmCalls: 0, tokens: 0 });
    return parts.get(key);
  };
  let since = null;
  for (const r of rows) {
    if (!since || r.week < since) since = r.week;
    const n = Number(r.n || 0), total = Number(r.total || 0);
    if (r.kind === 'api') { const p = part(r.key); p.requests += n; p.totalMs += total; }
    else if (r.kind === 'api_error') part(r.key).errors += n;
    else if (r.kind === 'api_slow') part(r.key).slow += n;
    else if (r.kind === 'tokens') {
      const p = part(r.key); p.llmCalls += n; p.tokens += total;
    }
  }
  const parts_ = [...parts.values()].map(p => ({
    key: p.key, requests: p.requests, errors: p.errors, slow: p.slow,
    avgMs: p.requests ? Math.round(p.totalMs / p.requests) : null,
    errorRate: p.requests ? p.errors / p.requests : null,
    llmCalls: p.llmCalls, tokens: Math.round(p.tokens),
  })).sort((a, b) => (b.tokens - a.tokens) || (b.requests - a.requests));
  return {
    since,
    parts: parts_,
    totals: {
      requests: parts_.reduce((s, p) => s + p.requests, 0),
      errors: parts_.reduce((s, p) => s + p.errors, 0),
      tokens: parts_.reduce((s, p) => s + p.tokens, 0),
      llmCalls: parts_.reduce((s, p) => s + p.llmCalls, 0),
    },
  };
}

/** Onderdeel van LEAP bij een API-pad, voor tellers (geen id's in de sleutel). */
export function featureOf(pathname, body) {
  const seg = String(pathname || '').split('?')[0].split('/').filter(Boolean);
  if (seg[0] !== 'api' || !seg[1]) return null;
  if (seg[1] === 'chat' && body && body.purpose === 'tutor_chat') {
    // Met bijlagen (afbeelding/bestand) apart, zodat de kosten zichtbaar zijn.
    return Array.isArray(body.attachments) && body.attachments.length > 0 ? 'chat-attachments' : 'chat';
  }
  if (seg[1] === 'chat') return 'ai-calls';
  if (seg[1] === 'admin' && seg[2]) return `admin/${seg[2]}`;
  if (seg[1] === 'analytics') return null; // zichzelf niet meten
  return seg[1];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// ── Per dag (2026-11-25) ────────────────────────────────────────────────────

/**
 * Verbergen als het aantal herleidbaar is: minder dan k studenten, of (met een
 * bekend totaal) op minder dan k na iedereen. Anders weet de docent bij "alle
 * 30 actief" wat elke student deed, of bij "29 van 30" iets over één student.
 */
const suppress = (n, k, total = 0) => {
  const few = n > 0 && n < k;
  // Op minder dan k na iedereen, of iedereen: dan is ook bekend wat (bijna) elke student deed.
  const nearAll = total > 0 && n > 0 && total - n < k;
  return few || nearAll ? { value: null, suppressed: true } : { value: n, suppressed: false };
};
/** Gemiddelde score afgerond op 10: zo valt door van periode te wisselen geen enkele student terug te rekenen. */
export const scoreBand = (avg) => (avg == null ? null : Math.round(avg / 10) * 10);
const sumBy = (rows, pick) => rows.reduce((s, r) => s + (pick(r) ? Number(r.n || 0) : 0), 0);

/**
 * Gebruik van één cursus door studenten (docent).
 *  dailyRows:  analytics_daily-rijen van deze cursus [{ day, kind, key, n }]
 *  weeklyRows: analytics_counters-rijen van deze cursus [{ week, kind, key, n }]
 * Elk aantal studenten onder k wordt verborgen (null + suppressed).
 */
export function buildCourseUsage({ dailyRows = [], weeklyRows = [], days = [], weeks = [], enrolled = 0, groups = 0, k = K_MIN }) {
  const daily = days.map((day) => {
    const s = suppress(sumBy(dailyRows, (r) => r.day === day && r.kind === 'active_students'), k, enrolled);
    return { day, activeStudents: s.value, suppressed: s.suppressed };
  });
  const weekly = weeks.map((week) => {
    const s = suppress(sumBy(weeklyRows, (r) => r.week === week && r.kind === 'active_students_week'), k, enrolled);
    return { week, activeStudents: s.value, suppressed: s.suppressed, share: s.value != null && enrolled > 0 ? s.value / enrolled : null };
  });
  const partKeys = [...new Set(Object.values(STUDENT_PARTS))];
  const parts = partKeys.map((part) => {
    const perWeek = weeks.map((week) => {
      const s = suppress(sumBy(weeklyRows, (r) => r.week === week && r.kind === 'active_part' && r.key === part), k, enrolled);
      return { week, students: s.value, suppressed: s.suppressed };
    });
    // Aandeel in alle acties alleen als het onderdeel ooit door ≥ k studenten in één week is gebruikt.
    const shown = perWeek.some((w) => (w.students || 0) >= k);
    return { part, weeks: perWeek, actions: shown ? sumBy(weeklyRows, (r) => r.kind === 'part_actions' && r.key === part) : null };
  });
  const totalActions = parts.reduce((s, p) => s + (p.actions || 0), 0);
  for (const p of parts) p.share = p.actions != null && totalActions > 0 ? p.actions / totalActions : null;
  // Projectgroepen: alleen tonen als de cursus minstens k groepen heeft, anders is "1 actief" herleidbaar.
  const groupWeeks = groups >= k
    ? weeks.map((week) => {
      const g = suppress(sumBy(weeklyRows, (r) => r.week === week && r.kind === 'active_group'), k, groups);
      return { week, activeGroups: g.value, suppressed: g.suppressed };
    })
    : null;
  return { k, enrolled, daily, weekly, parts, groups: { total: groups, suppressed: groups < k, weeks: groupWeeks } };
}

/**
 * Ik leg uit per begrip (docent). rows: [{ student_id, concept_id, score }]
 * (score = 0–100). Gemiddeld per student eerst; onder k studenten verborgen.
 */
export function explainPerConcept(rows = [], namesById = {}, k = K_MIN) {
  const by = new Map();
  for (const r of rows) {
    if (!namesById[r.concept_id] || typeof r.score !== 'number') continue;
    if (!by.has(r.concept_id)) by.set(r.concept_id, []);
    by.get(r.concept_id).push({ student_id: r.student_id, score_percentage: r.score });
  }
  return [...by.entries()].map(([id, list]) => {
    const a = perStudentAverage(list);
    const hidden = a.students < k;
    return { name: namesById[id], students: hidden ? null : a.students, avgScore: hidden ? null : scoreBand(a.avg), suppressed: hidden };
  }).sort((x, y) => (y.students ?? 0) - (x.students ?? 0) || x.name.localeCompare(y.name, 'nl'));
}

/**
 * Behaalde achievements in een cursus (docent). rows: [{ user_id, kind, earned_at }]
 * Alles verborgen als minder dan k studenten er een behaalden.
 */
export function summarizeAchievements(rows = [], { enrolled = 0, weeks = [], k = K_MIN } = {}) {
  const students = new Set(rows.map((r) => r.user_id));
  if (students.size < k) return { k, suppressed: true, total: null, students: null, share: null, kinds: [], weeks: [] };
  const kinds = new Map();
  for (const r of rows) {
    const cur = kinds.get(r.kind) || { kind: r.kind, count: 0, students: new Set() };
    cur.count += 1; cur.students.add(r.user_id);
    kinds.set(r.kind, cur);
  }
  return {
    k,
    suppressed: false,
    total: rows.length,
    students: students.size,
    share: enrolled > 0 ? students.size / enrolled : null,
    // Per soort alleen als ≥ k studenten die soort behaalden; anders is "2" herleidbaar.
    kinds: [...kinds.values()].map((v) => (v.students.size >= k
      ? { kind: v.kind, count: v.count, students: v.students.size, suppressed: false }
      : { kind: v.kind, count: null, students: null, suppressed: true }))
      .sort((a, b) => b.count - a.count),
    weeks: weeks.map((week) => {
      const inWeek = rows.filter((r) => r.earned_at && weekStart(new Date(r.earned_at)) === week);
      const hidden = new Set(inWeek.map((r) => r.user_id)).size < k && inWeek.length > 0;
      return { week, count: hidden ? null : inWeek.length, suppressed: hidden };
    }),
  };
}

/**
 * Kosten en gebruik per dag (beheerder). rows: analytics_daily [{ day, course_id, kind, key, n, total }].
 * Met courseId alleen die cursus; zonder: heel LEAP.
 */
export function summarizeDaily(rows = [], { days = [], courseId = null, courseNames = {}, k = K_MIN } = {}) {
  const inScope = (r) => (courseId ? r.course_id === courseId : true);
  const tokens = rows.filter((r) => r.kind === 'tokens' && inScope(r));
  const usersRows = rows.filter((r) => r.kind === 'active_users' && (courseId ? r.course_id === courseId : !r.course_id));
  const byDay = days.map((day) => {
    const t = tokens.filter((r) => r.day === day);
    const groups = { students: 0, teachers: 0, background: 0, other: 0 };
    for (const r of t) groups[tokenGroupOf(r.key)] += Number(r.total || 0);
    return {
      day,
      tokens: Math.round(t.reduce((s, r) => s + Number(r.total || 0), 0)),
      groups: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, Math.round(v)])),
      // Per cursus geldt ook voor de beheerder de drempel ("1 student" is één persoon); voor heel LEAP niet nodig.
      students: courseId ? suppress(sumBy(usersRows, (r) => r.day === day && r.key === 'student'), k).value : sumBy(usersRows, (r) => r.day === day && r.key === 'student'),
      staff: sumBy(usersRows, (r) => r.day === day && r.key === 'staff'),
    };
  });
  const groupTotals = { students: 0, teachers: 0, background: 0, other: 0 };
  const byPart = new Map();
  for (const r of tokens) {
    groupTotals[tokenGroupOf(r.key)] += Number(r.total || 0);
    byPart.set(r.key, (byPart.get(r.key) || 0) + Number(r.total || 0));
  }
  const byCourse = new Map();
  for (const r of rows) {
    if (r.kind !== 'tokens') continue;
    const ck = r.course_id || '';
    byCourse.set(ck, (byCourse.get(ck) || 0) + Number(r.total || 0));
  }
  return {
    days: byDay,
    totalTokens: byDay.reduce((s, d) => s + d.tokens, 0),
    groups: Object.fromEntries(Object.entries(groupTotals).map(([g, v]) => [g, Math.round(v)])),
    parts: [...byPart.entries()].map(([key, v]) => ({ key, group: tokenGroupOf(key), tokens: Math.round(v) })).sort((a, b) => b.tokens - a.tokens),
    courses: [...byCourse.entries()].map(([id, v]) => ({ courseId: id || null, name: id ? (courseNames[id] || null) : null, tokens: Math.round(v) }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
