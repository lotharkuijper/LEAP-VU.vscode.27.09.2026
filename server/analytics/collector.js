// Analytics — tellen zonder iets over personen te bewaren.
//
// Drie bronnen, alle drie zonder aanpassingen in bestaande routes:
//  1. een middleware die per API-verzoek telt: onderdeel, duur, serverfout;
//  2. een meter rond de globale fetch die het tokengebruik van Azure OpenAI
//     uit het antwoord leest (usage.total_tokens) en toeschrijft aan het
//     onderdeel en de cursus van het lopende verzoek (AsyncLocalStorage);
//  3. bij de tutorchat (/api/chat met purpose 'tutor_chat'): vond de chat
//     bewijs in het cursusmateriaal, en over welk begrip ging de vraag. De
//     tekst van de vraag wordt alleen in het geheugen vergeleken met de
//     begrippenlijst en nooit opgeslagen.
//
// Tellingen gaan eerst naar een buffer in het geheugen en worden elke minuut
// in één aanroep weggeschreven (DB-functie analytics_bump). Bij een herstart
// kan hooguit de laatste minuut verloren gaan; voor tellers is dat acceptabel.

import { AsyncLocalStorage } from 'node:async_hooks';
import { weekStart, amsterdamDay, featureOf, isUuid, matchConcepts, studentPartOf } from './aggregate.js';

const als = new AsyncLocalStorage();
const SLOW_MS = 10000;

export function createCollector({ write, now = () => new Date(), log = console } = {}) {
  const buf = new Map();
  let pausedUntil = 0;
  // "Wie is vandaag/deze week al geteld": alleen in het geheugen, nooit opgeslagen.
  // Bij een herstart begint dit opnieuw; iemand kan dan die dag twee keer tellen.
  const seen = { day: new Set(), week: new Set() };
  const seenFor = { day: '', week: '' };

  // Elke rij hoort bij een week (analytics_counters) én een dag (analytics_daily).
  function bump(kind, key = '', { courseId = null, n = 1, total = 0 } = {}) {
    const at = now();
    const week = weekStart(at);
    const day = amsterdamDay(at);
    const cid = isUuid(courseId) ? courseId : null;
    const k = `${day}|${cid || ''}|${kind}|${key}`;
    const cur = buf.get(k) || { week, day, course_id: cid, kind, key: String(key).slice(0, 200), n: 0, total: 0 };
    cur.n += n; cur.total += total;
    buf.set(k, cur);
  }

  /** Eén keer per periode tellen ('day' of 'week'); id (bv. gebruiker) blijft in het geheugen. */
  function bumpOnce(period, id, kind, key = '', { courseId = null } = {}) {
    const at = now();
    const p = period === 'week' ? 'week' : 'day';
    const current = p === 'week' ? weekStart(at) : amsterdamDay(at);
    if (seenFor[p] !== current) { seen[p].clear(); seenFor[p] = current; }
    const k = `${courseId || ''}|${kind}|${key}|${id}`;
    if (seen[p].has(k)) return;
    // Begrensd: bij een (onwaarschijnlijk) enorme set liever iemand dubbel tellen dan geheugen vol.
    if (seen[p].size > 200000) seen[p].clear();
    seen[p].add(k);
    bump(kind, key, { courseId });
  }

  function drain() {
    const rows = [...buf.values()];
    buf.clear();
    return rows;
  }

  async function flush() {
    if (!buf.size) return 0;
    const rows = drain();
    if (Date.now() < pausedUntil) return 0;
    try {
      await write(rows);
      return rows.length;
    } catch (err) {
      // Bv. de migratie is nog niet toegepast: 10 minuten pauze, niet blijven loggen.
      pausedUntil = Date.now() + 10 * 60 * 1000;
      log.warn?.(`[analytics] tellers niet opgeslagen (${err?.message || err}); 10 min pauze.`);
      return 0;
    }
  }

  return { bump, bumpOnce, drain, flush, size: () => buf.size };
}

/** Groep uit een projectpad (/api/projects/…/groups/<id>/…), voor "actieve groepen". */
export function groupIdOf(path) {
  const seg = String(path || '').split('?')[0].split('/');
  const i = seg.indexOf('groups');
  return i >= 0 && isUuid(seg[i + 1]) ? seg[i + 1] : null;
}

/**
 * Activiteit tellen zonder iets over personen op te slaan. Alleen geslaagde
 * acties (geen GET: openen telt niet als gebruiken). Per dag en per week:
 *  - active_users   key 'student'|'staff', per cursus en voor heel LEAP (course null)
 *  - active_students per cursus (dag en week)
 *  - active_part    key = onderdeel, studenten per week
 *  - part_actions   key = onderdeel, aantal acties
 *  - active_group   projectgroepen met activiteit, per week
 * `who(userId, courseId)` geeft { courseId, role }: de cursus (valt terug op de
 * laatst gekozen cursus als het verzoek er geen noemt) en 'student' of iets
 * anders (docent, beheerder). Alleen 'student' telt als student.
 */
export async function recordActivity(collector, { userId, feature, courseId, method, path, status }, who) {
  if (!userId || method === 'GET' || status >= 400 || !who) return;
  const ctx = await who(userId, courseId);
  const role = ctx?.role === 'student' ? 'student' : 'staff';
  collector.bumpOnce('day', userId, 'active_users', role, { courseId: null });
  const cid = ctx?.courseId || null;
  if (!cid) return;
  collector.bumpOnce('day', userId, 'active_users', role, { courseId: cid });
  if (role !== 'student') return;
  collector.bumpOnce('day', userId, 'active_students', '', { courseId: cid });
  collector.bumpOnce('week', userId, 'active_students_week', '', { courseId: cid });
  const part = studentPartOf(feature);
  if (part) {
    collector.bumpOnce('week', userId, 'active_part', part, { courseId: cid });
    collector.bump('part_actions', part, { courseId: cid });
  }
  const group = feature === 'projects' ? groupIdOf(path) : null;
  if (group) collector.bumpOnce('week', group, 'active_group', '', { courseId: cid });
}

function courseIdOf(req) {
  const c = req.body?.courseId ?? req.query?.courseId ?? req.params?.courseId;
  return isUuid(c) ? c : null;
}

/** Laatste bericht van de gebruiker (alleen in het geheugen gebruikt). */
function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user' && typeof msgs[i].content === 'string') return msgs[i].content;
  }
  return '';
}

/**
 * Middleware: meet elk /api-verzoek. `conceptsFor(courseId)` levert de
 * begrippen [{ name, aliases }] voor de chat-herkenning (mag cachen).
 */
export function analyticsMiddleware(collector, { conceptsFor, who, verifyUser } = {}) {
  return (req, res, next) => {
    let feature = null;
    try { feature = featureOf(req.path || req.url, req.body); } catch { feature = null; }
    if (!feature) return next();
    const store = { feature, courseId: courseIdOf(req), done: false, calls: 0, tokens: 0 };
    const t0 = Date.now();
    res.on('finish', () => {
      try {
        store.done = true;
        const courseId = courseIdOf(req) || store.courseId;
        store.courseId = courseId;
        const ms = Date.now() - t0;
        collector.bump('api', feature, { courseId, total: ms });
        if (res.statusCode >= 500) collector.bump('api_error', feature, { courseId });
        if (ms > SLOW_MS) collector.bump('api_slow', feature, { courseId });
        if (store.calls) collector.bump('tokens', feature, { courseId, n: store.calls, total: store.tokens });
        // Alleen een gebruiker wiens login de server zelf heeft gecontroleerd (verifyUser),
        // nooit een id uit een ongecontroleerd token: anders kan iemand activiteit namaken.
        if (verifyUser && who && req.method !== 'GET' && res.statusCode < 400 && req.headers?.authorization) {
          Promise.resolve(verifyUser(req)).then((userId) => recordActivity(collector, {
            userId, feature, courseId, method: req.method, path: req.path || req.url, status: res.statusCode,
          }, who)).catch(() => {});
        }
        if ((feature === 'chat' || feature === 'chat-attachments') && courseId && res.statusCode < 400) {
          recordChatEvidence(collector, req.body, courseId, conceptsFor);
          if (feature === 'chat-attachments') recordAttachments(collector, req.body, courseId);
        }
      } catch { /* meten mag nooit iets breken */ }
    });
    als.run(store, next);
  };
}

// Bijlagen in de chat: alleen het aantal per soort, nooit naam of inhoud.
function recordAttachments(collector, body, courseId) {
  for (const a of body.attachments) {
    if (a?.kind === 'image' || (a?.kind === 'file' && a.isNew === true)) collector.bump('chat_attachment', a.kind, { courseId });
  }
}

function recordChatEvidence(collector, body, courseId, conceptsFor) {
  const hit = Array.isArray(body?.sources) && body.sources.length > 0;
  collector.bump('chat_evidence', hit ? 'hit' : 'miss', { courseId });
  const text = lastUserText(body);
  if (!text || !conceptsFor) return;
  Promise.resolve(conceptsFor(courseId)).then((concepts) => {
    for (const name of matchConcepts(text, concepts)) {
      collector.bump(hit ? 'chat_concept_hit' : 'chat_concept_miss', name, { courseId });
    }
  }).catch(() => {});
}

/** Tokens bijschrijven bij het lopende verzoek (of direct, als het al klaar is). */
export function recordTokens(collector, tokens) {
  const store = als.getStore();
  if (!store) { collector.bump('tokens', 'background', { total: tokens }); return; }
  if (store.done) { collector.bump('tokens', store.feature, { courseId: store.courseId, total: tokens }); return; }
  store.calls += 1;
  store.tokens += tokens;
}

/** Is dit een aanroep naar Azure OpenAI (chat of embeddings)? */
export function isLlmUrl(url) {
  return /\/openai\/deployments\/[^/]+\/(chat\/completions|embeddings)\b/.test(String(url || ''));
}

/**
 * Vervang globalThis.fetch door een versie die het tokengebruik van Azure
 * OpenAI telt. Het antwoord zelf blijft ongemoeid (we lezen een kloon).
 * Streams (text/event-stream) worden niet gelezen.
 */
export function installFetchMeter(collector, target = globalThis) {
  const orig = target.fetch;
  if (typeof orig !== 'function' || orig.__leapAnalytics) return () => {};
  const metered = async function meteredFetch(input, init) {
    const res = await orig(input, init);
    try {
      const url = typeof input === 'string' ? input : (input?.url || String(input));
      const type = res?.headers?.get?.('content-type') || '';
      if (res?.ok && isLlmUrl(url) && type.includes('json') && typeof res.clone === 'function') {
        const store = als.getStore();
        res.clone().json().then((j) => {
          const u = j?.usage;
          const tokens = Number(u?.total_tokens ?? ((u?.prompt_tokens || 0) + (u?.completion_tokens || 0)));
          if (tokens > 0) als.run(store, () => recordTokens(collector, tokens));
        }).catch(() => {});
      }
    } catch { /* meten mag nooit iets breken */ }
    return res;
  };
  metered.__leapAnalytics = true;
  target.fetch = metered;
  return () => { target.fetch = orig; };
}
