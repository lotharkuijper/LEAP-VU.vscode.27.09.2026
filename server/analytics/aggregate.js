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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
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
 * Begrippen-thermometer voor één cursus.
 *  attempts: [{ student_id, topics: string[], score_percentage }]
 *  concepts: [{ name, aliases }]
 *  chatRows: tellers [{ kind, key, n }] met kind 'chat_concept_hit' / 'chat_concept_miss'
 *            (key = begripnaam) en 'chat_evidence' (key = 'hit' | 'miss')
 * De student_id's worden alleen geteld, nooit teruggegeven.
 */
export function buildConceptThermometer({ attempts = [], concepts = [], chatRows = [], k = K_MIN }) {
  const perConcept = concepts.map(c => {
    const students = new Set();
    let sum = 0, n = 0;
    for (const a of attempts) {
      if (!Array.isArray(a.topics) || !a.topics.some(t => topicMatches(t, c))) continue;
      if (typeof a.score_percentage !== 'number') continue;
      students.add(a.student_id);
      sum += a.score_percentage;
      n++;
    }
    const enough = students.size >= k;
    const chat = (kind) => chatRows.filter(r => r.kind === kind && r.key === c.name).reduce((s, r) => s + Number(r.n || 0), 0);
    const asked = chat('chat_concept_hit') + chat('chat_concept_miss');
    const misses = chat('chat_concept_miss');
    return {
      name: c.name,
      quiz: {
        attempts: enough ? n : null,
        avgScore: enough && n ? Math.round(sum / n) : null,
        suppressed: students.size > 0 && !enough,
      },
      chat: { asked, misses },
    };
  });

  const ev = (key) => chatRows.filter(r => r.kind === 'chat_evidence' && r.key === key).reduce((s, r) => s + Number(r.n || 0), 0);
  const allStudents = new Set(attempts.filter(a => typeof a.score_percentage === 'number').map(a => a.student_id));
  const scored = attempts.filter(a => typeof a.score_percentage === 'number');
  const courseEnough = allStudents.size >= k;

  return {
    k,
    quiz: {
      attempts: courseEnough ? scored.length : null,
      avgScore: courseEnough && scored.length ? Math.round(scored.reduce((s, a) => s + a.score_percentage, 0) / scored.length) : null,
      suppressed: allStudents.size > 0 && !courseEnough,
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
    const cur = byWeek.get(w) || { students: new Set(), sum: 0, n: 0 };
    cur.students.add(a.student_id); cur.sum += a.score_percentage; cur.n++;
    byWeek.set(w, cur);
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => (
    v.students.size >= k
      ? { week, avgScore: Math.round(v.sum / v.n), attempts: v.n }
      : { week, avgScore: null, attempts: null, suppressed: true }
  ));
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
export function summarizePlatform(rows = [], courseNames = {}) {
  const parts = new Map();
  const part = (key) => {
    if (!parts.has(key)) parts.set(key, { key, requests: 0, errors: 0, slow: 0, totalMs: 0, llmCalls: 0, tokens: 0 });
    return parts.get(key);
  };
  const tokensByCourse = new Map();
  const tokensByWeek = new Map();
  let since = null;
  for (const r of rows) {
    if (!since || r.week < since) since = r.week;
    const n = Number(r.n || 0), total = Number(r.total || 0);
    if (r.kind === 'api') { const p = part(r.key); p.requests += n; p.totalMs += total; }
    else if (r.kind === 'api_error') part(r.key).errors += n;
    else if (r.kind === 'api_slow') part(r.key).slow += n;
    else if (r.kind === 'tokens') {
      const p = part(r.key); p.llmCalls += n; p.tokens += total;
      const ck = r.course_id || '';
      tokensByCourse.set(ck, (tokensByCourse.get(ck) || 0) + total);
      tokensByWeek.set(r.week, (tokensByWeek.get(r.week) || 0) + total);
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
    tokensByCourse: [...tokensByCourse.entries()]
      .map(([id, tokens]) => ({ courseId: id || null, name: id ? (courseNames[id] || null) : null, tokens: Math.round(tokens) }))
      .sort((a, b) => b.tokens - a.tokens),
    tokensByWeek: [...tokensByWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, tokens]) => ({ week, tokens: Math.round(tokens) })),
  };
}

/** Onderdeel van LEAP bij een API-pad, voor tellers (geen id's in de sleutel). */
export function featureOf(pathname, body) {
  const seg = String(pathname || '').split('?')[0].split('/').filter(Boolean);
  if (seg[0] !== 'api' || !seg[1]) return null;
  if (seg[1] === 'chat' && body && body.purpose === 'tutor_chat') return 'chat';
  if (seg[1] === 'chat') return 'ai-calls';
  if (seg[1] === 'admin' && seg[2]) return `admin/${seg[2]}`;
  if (seg[1] === 'analytics') return null; // zichzelf niet meten
  return seg[1];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
