// "Verbeter deze uitleg" (2026-10-20), een onderdeel van Ik leg uit.
//
// Een student kiest een begrip en krijgt een uitleg die TER PLEKKE door het
// taalmodel is gemaakt, met één tot drie bewust aangebrachte fouten. De student
// weet niet hoeveel; hij wijst ze aan en legt uit wat eraan fout is.
//
// Zo ontstaat een oefening (makeExercise):
//   1. één aanroep schrijft eerst een JUISTE uitleg uit de cursusfragmenten en
//      maakt daarvan een versie met K fouten (K willekeurig 1..3, elk wezenlijk);
//   2. een BLINDE controle (weet niet dat er fouten in zitten) moet precies de
//      bedoelde fouten vinden, allemaal wezenlijk, zonder extra fouten en zonder
//      dat de tekst zichzelf tegenspreekt. Anders opnieuw, maximaal 3 pogingen.
// Geen mens beoordeelt de oefeningen vooraf en er wordt niets bewaard: de juiste
// versie en de lijst met fouten gaan VERSLEUTELD naar de browser
// (sealExercise) en alleen de server kan ze bij het beoordelen weer openen.
// Vangnet achteraf: de disclaimer en "Klopt dit wel?" (Studiecafé).
// Meting fase 0: scripts/eval-flawed-explanations.mjs (60 begrippen, 94% "goed").

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { journalFormatInstruction, journalFieldsFromModel } from '../journal/journalSections.js';

export const ERROR_TYPES = Object.freeze([
  'verwant_begrip', 'oorzaak_gevolg', 'te_ruim_te_smal', 'noodzakelijk_voldoende', 'richting_teken', 'voorwaarde_weggelaten',
]);
export const MAX_ATTEMPTS = 3;
export const MIN_SOURCES = 2;
export const MAX_ANSWER_CHARS = 6000;
export const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;
export const DAILY_LIMIT = 40;

/** Het model schrijft de soort soms net anders ("te_smal", "oorzaak-gevolg"); terug naar de vaste lijst. */
export function normalizeErrorType(s) {
  const t = String(s || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (ERROR_TYPES.includes(t)) return t;
  if (/^te_(ruim|smal|breed)/.test(t) || /generali/.test(t)) return 'te_ruim_te_smal';
  if (/oorzaak|gevolg|causa/.test(t)) return 'oorzaak_gevolg';
  if (/verwant|verwar|begrip/.test(t)) return 'verwant_begrip';
  if (/noodzakelijk|voldoende/.test(t)) return 'noodzakelijk_voldoende';
  if (/richting|teken/.test(t)) return 'richting_teken';
  if (/voorwaarde|uitzondering/.test(t)) return 'voorwaarde_weggelaten';
  return null;
}

/** 1, 2 of 3 fouten (40% / 35% / 25%). */
export function pickErrorCount(rand = Math.random) {
  const r = rand();
  return r < 0.4 ? 1 : r < 0.75 ? 2 : 3;
}

export function sourcesText(chunks) {
  return chunks.map((c, i) => `[${i + 1}] ${String(c.content || '').slice(0, 1600)}`).join('\n\n');
}

export function generateSystem(lang = 'nl') {
  return `Je maakt een oefening voor studenten: een korte uitleg van een begrip waarin bewust fouten zijn verwerkt. De student moet zelf de fouten vinden en uitleggen wat eraan fout is, zonder te weten hoeveel het er zijn.

Werkwijze:
1. Schrijf eerst een JUISTE uitleg van het begrip: 4 tot 7 zinnen, op het niveau van een student, uitsluitend gebaseerd op de genummerde bronfragmenten.
2. Maak daarvan een versie met precies K fouten (K staat in de opdracht). Verander per fout één bewering; laat de rest zo veel mogelijk gelijk.

Eisen aan elke fout:
- objectief onjuist volgens de bronfragmenten, aan te wijzen met een fragment;
- wezenlijk: een echte misvatting waarvoor een student op een tentamen punten zou verliezen. Dus GEEN woordkeus, afronding, stijl, spelling, of een detail dat er niet toe doet;
- scherp: in geen enkele redelijke lezing te verdedigen (dus niet iets dat omslachtig maar strikt genomen nog juist is);
- geloofwaardig: zo geformuleerd dat een student die het begrip half begrijpt het zou kunnen geloven. Geen simpele ontkenning, niets absurds;
- de fouten verschillen van elkaar en de tekst spreekt zichzelf NERGENS tegen (een fout mag niet door een andere zin in de tekst verraden worden); de tekst leest vloeiend en overtuigend;
- kies per fout een soort: verwant_begrip (verwarring met een verwant begrip; gebruik bij voorkeur een begrip uit de lijst "Verwante begrippen"), oorzaak_gevolg, te_ruim_te_smal, noodzakelijk_voldoende, richting_teken, voorwaarde_weggelaten. Gebruik bij meer fouten verschillende soorten;
- niets in de tekst mag de fouten verraden (geen markering, geen "let op"), en de tekst verwijst niet naar "de bron", "het fragment" of "de cursus".

Antwoord uitsluitend met JSON:
{"juist": "...", "fout": "...", "fouten": [{"zin": "letterlijke zin of zinsdeel uit 'fout' met de fout", "soort": "...", "waarom_fout": "...", "juist_is": "...", "bron": <nummer>}]}
Schrijf "juist", "fout", "waarom_fout" en "juist_is" in het Nederlands, tenzij hieronder een andere taal wordt gevraagd; vaktermen mag je laten zoals ze in de fragmenten staan.${buildLanguageInstruction(lang, { json: true })}`;
}

export function generateUser({ concept, related = [], k, chunks }) {
  return `Begrip: ${concept.name}\nDefinitie in de cursus: ${concept.definition || '(geen)'}\nVerwante begrippen in de cursus: ${related.join(', ') || '(geen)'}\nK = ${k}\n\nBronfragmenten:\n${sourcesText(chunks)}`;
}

export const VERIFY_SYSTEM = `Je bent een zorgvuldige vakdocent. Je krijgt een korte uitleg van een begrip, geschreven voor studenten, en genummerde fragmenten uit het cursusmateriaal.
Controleer elke bewering. Noem ALLE beweringen die onjuist zijn volgens de fragmenten of volgens algemeen aanvaarde vakkennis.
Per onjuistheid: "citaat" (letterlijk uit de uitleg), "waarom" (kort), "ernst": "wezenlijk" (een echte misvatting) of "marginaal" (onnauwkeurig of slordig, maar geen echte fout), "bron" (nummer van het fragment, of 0 als het niet uit de fragmenten volgt).
Noem een bewering NIET als ze juist is, ook niet als ze eenvoudiger is geformuleerd dan in de bron.
Antwoord uitsluitend met JSON: {"onjuistheden": [{"citaat": "...", "waarom": "...", "ernst": "...", "bron": 0}]}`;

export function verifyUser({ concept, text, chunks }) {
  return `Begrip: ${concept.name}\n\nUitleg:\n${text}\n\nFragmenten uit het cursusmateriaal:\n${sourcesText(chunks)}`;
}

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(w => w.length > 2);
/** Woordoverlap van a en b, gedeeld door de kleinste van de twee (0..1). */
export function overlap(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** Vorm en inhoud van de gemaakte oefening; null = in orde, anders de reden. Normaliseert de soorten. */
export function structuralCheck(g, k, nSources) {
  if (!g || typeof g.juist !== 'string' || typeof g.fout !== 'string' || !Array.isArray(g.fouten)) return 'geen geldige JSON';
  if (!g.juist.trim() || !g.fout.trim()) return 'lege tekst';
  if (g.fouten.length !== k) return `aantal fouten ${g.fouten.length} ≠ ${k}`;
  for (const f of g.fouten) {
    const soort = normalizeErrorType(f?.soort);
    if (!soort) return `onbekende soort ${f?.soort}`;
    f.soort = soort;
    if (overlap(f.zin, g.fout) < 0.8) return 'zin niet terug te vinden in de tekst';
    if (!(Number(f.bron) >= 1 && Number(f.bron) <= nSources)) return 'geen geldige bron';
  }
  if (g.juist.trim() === g.fout.trim()) return 'foute tekst gelijk aan juiste';
  return null;
}

/** Blinde controle → goed als precies de bedoelde fouten gevonden zijn, allemaal wezenlijk, zonder extra wezenlijke fouten.
 *  (Tegenspraak binnen de tekst is bewust GEEN afkeurgrond: een fout botst vaak vanzelf met een juiste zin,
 *  en zo afkeuren gaf in de meting veel te veel begrippen zonder oefening. Het maak-model krijgt het wel als eis.) */
export function matchVerification(g, v) {
  const found = Array.isArray(v?.onjuistheden) ? v.onjuistheden : [];
  const used = new Set();
  const perIntended = g.fouten.map((f) => {
    let best = -1, bestScore = 0;
    found.forEach((x, i) => {
      if (used.has(i)) return;
      const s = overlap(f.zin, x?.citaat);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best >= 0 && bestScore >= 0.5) { used.add(best); return { found: true, wezenlijk: found[best].ernst === 'wezenlijk' }; }
    return { found: false, wezenlijk: false };
  });
  const extraWezenlijk = found.filter((x, i) => !used.has(i) && x?.ernst === 'wezenlijk').length;
  const missed = perIntended.filter(p => !p.found).length;
  const marginal = perIntended.filter(p => p.found && !p.wezenlijk).length;
  const ok = !!v && missed === 0 && marginal === 0 && extraWezenlijk === 0;
  const reason = ok ? 'goedgekeurd' : !v ? 'geen controle-uitslag' : [
    missed && `${missed} niet gevonden`,
    marginal && `${marginal} als marginaal gezien`,
    extraWezenlijk && `${extraWezenlijk} extra fout(en)`,
  ].filter(Boolean).join(', ');
  return { ok, reason };
}

/**
 * Maakt één oefening: genereren + blinde controle, maximaal MAX_ATTEMPTS keer.
 * llmJson(system, user, { effort }) → geparste JSON of null.
 */
export async function makeExercise({ concept, chunks, related = [], llmJson, lang = 'nl', rand = Math.random, maxAttempts = MAX_ATTEMPTS, onAttempt = null }) {
  const k = pickErrorCount(rand);
  const attempts = [];
  for (let a = 1; a <= maxAttempts; a++) {
    const g = await llmJson(generateSystem(lang), generateUser({ concept, related, k, chunks }), { effort: 'low' });
    const structural = structuralCheck(g, k, chunks.length);
    if (structural) { attempts.push({ attempt: a, ok: false, reason: structural }); onAttempt?.({ attempt: a, ok: false, reason: structural, g }); continue; }
    const v = await llmJson(VERIFY_SYSTEM, verifyUser({ concept, text: g.fout, chunks }), { effort: 'medium' });
    const m = matchVerification(g, v);
    attempts.push({ attempt: a, ok: m.ok, reason: m.reason });
    onAttempt?.({ attempt: a, ok: m.ok, reason: m.reason, g, v });
    if (m.ok) {
      return {
        ok: true, k, attempts,
        exercise: {
          flawed: g.fout.trim(),
          correct: g.juist.trim(),
          errors: g.fouten.map(f => ({
            sentence: String(f.zin || '').trim(),
            type: f.soort,
            why: String(f.waarom_fout || '').trim(),
            correct: String(f.juist_is || '').trim(),
            source: Number(f.bron),
          })),
        },
      };
    }
  }
  return { ok: false, k, attempts };
}

// ── Versleuteld pakketje: alleen de server kan het openen ─────────────────────
function keyFrom(secret) {
  return createHash('sha256').update(`${secret}:flawed-explanations:v1`).digest();
}

export function sealExercise(payload, secret, now = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + TOKEN_TTL_MS }), 'utf8');
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

/** null bij een ongeldig, aangepast of verlopen pakketje. */
export function openExercise(token, secret, now = Date.now()) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Beoordelen van het antwoord van de student ───────────────────────────────
export function evaluationSystem(lang = 'nl') {
  return `Je beoordeelt het antwoord van een student op een oefening. De student kreeg een uitleg van een begrip waarin bewust fouten waren gestopt, zonder te weten hoeveel. De opdracht: wijs de fouten aan en leg uit wat eraan fout is.
Je krijgt de uitleg met fouten, de lijst met bedoelde fouten (met wat juist is), fragmenten uit het cursusmateriaal en het antwoord van de student.

Beoordeel eerlijk en bemoedigend, en spreek de student direct aan met "je".
- Een fout telt als gevonden als de student de juiste bewering aanwijst EN in de kern goed zegt wat eraan fout is. Alleen aanwijzen zonder (juiste) uitleg is "deels".
- Wijst de student iets aan dat wél klopte, zeg dat vriendelijk en leg uit waarom het juist is.
- Noem de bedoelde fouten die de student miste NIET bij naam en geef het juiste antwoord niet: de student ziet dat straks zelf.
- Verwijs waar het helpt naar een fragment met [nummer].

Gebruik precies deze kopjes, letterlijk zo geschreven (Engels, hoofdletters), elk op een eigen regel:
### FOUND
Eerste regel: "<aantal gevonden>/<aantal bedoelde fouten>", bijvoorbeeld 2/3. Daarna per door de student aangewezen fout één regel "- ..." met: gevonden, deels, of klopt eigenlijk wel.
### REASONING
2 à 4 zinnen over de kwaliteit van de uitleg die de student gaf bij de fouten die hij vond.
### WRONGLY_FLAGGED
Wat de student ten onrechte als fout aanwees, met waarom het juist is. Schrijf "-" als dat niet zo is.
### NEXT_STEP
1 à 2 concrete vervolgstappen.${buildLanguageInstruction(lang)}`;
}

export function evaluationUser({ concept, payload, answer }) {
  const errors = payload.errors.map((e, i) => `${i + 1}. "${e.sentence}" — waarom fout: ${e.why} — juist is: ${e.correct} [${e.source}]`).join('\n');
  const sources = (payload.sources || []).map(s => `[${s.index}] ${s.excerpt}`).join('\n\n');
  return `Begrip: ${concept}\n\nUitleg met fouten:\n${payload.flawed}\n\nBedoelde fouten (${payload.errors.length}):\n${errors}\n\nFragmenten:\n${sources}\n\nAntwoord van de student:\n"""\n${answer}\n"""`;
}

const EVAL_MARKER = /^\s*#{1,4}\s*\**\s*(FOUND|REASONING|WRONGLY[_ ]FLAGGED|NEXT[_ ]STEPS?)\s*\**\s*:?\s*$/i;

/** Leest de vier blokken; null als er geen enkel kopje in staat. */
export function parseEvaluation(raw, total) {
  const blocks = {};
  let cur = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(EVAL_MARKER);
    if (m) { cur = m[1].toUpperCase().replace(' ', '_').replace(/^NEXT_STEPS$/, 'NEXT_STEP'); blocks[cur] = []; continue; }
    if (cur) blocks[cur].push(line);
  }
  if (!Object.keys(blocks).length) return null;
  const text = (k) => (blocks[k] || []).join('\n').trim();
  let foundText = text('FOUND');
  let found = null;
  const frac = foundText.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    found = Math.max(0, Math.min(total, Number(frac[1])));
    foundText = foundText.replace(frac[0], '').replace(/^\s*[\n:.-]*/, '').trim();
  }
  const wrong = text('WRONGLY_FLAGGED');
  return {
    found,
    total,
    foundDetail: foundText,
    reasoning: text('REASONING'),
    wronglyFlagged: /^[-–—\s]*$/.test(wrong) ? '' : wrong,
    nextStep: text('NEXT_STEP'),
  };
}

// ── Dagelijkse limiet per student (procesgeheugen; één replica) ──────────────
export function createDailyLimiter(limit = DAILY_LIMIT) {
  const map = new Map();
  return {
    take(userId, now = new Date()) {
      const day = now.toISOString().slice(0, 10);
      const k = `${userId}:${day}`;
      const n = map.get(k) || 0;
      if (n >= limit) return false;
      map.set(k, n + 1);
      if (map.size > 5000) for (const key of map.keys()) if (!key.endsWith(day)) map.delete(key);
      return true;
    },
  };
}

/**
 * Routes. deps:
 *   supabaseAdmin, requireAuthUser, userHasCourseAccess(user, profile, courseId),
 *   rejectIfFeatureOff(res, user, profile, courseId, feature), courseFeatureOnFor(user, profile, courseId, feature),
 *   isStaffForCourse(user, profile, courseId), getChunks(concept, courseId) → [{content, documentId, title}],
 *   llmJson(system, user, {effort}), llmText(system, user, {effort, maxTokens}), secret,
 *   resolveJournalCourseId(courseId, user), llmReady: boolean
 */
export function registerFlawedExplanationRoutes(app, deps) {
  const { supabaseAdmin: db, requireAuthUser } = deps;
  const limiter = deps.limiter || createDailyLimiter();

  async function gate(req, res, courseId) {
    if (courseId && !(await deps.userHasCourseAccess(req.auth.user, req.auth.profile, courseId))) {
      res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      return false;
    }
    if (await deps.rejectIfFeatureOff(res, req.auth.user, req.auth.profile, courseId, 'explain')) return false;
    if (await deps.rejectIfFeatureOff(res, req.auth.user, req.auth.profile, courseId, 'explainImprove')) return false;
    return true;
  }

  function openFor(req, res) {
    const payload = openExercise(req.body?.token, deps.secret);
    if (!payload) { res.status(400).json({ error: 'Deze oefening is verlopen of ongeldig. Maak een nieuwe.', code: 'exerciseExpired' }); return null; }
    if (payload.uid !== req.auth.user.id) { res.status(403).json({ error: 'Deze oefening is niet van jou', code: 'exerciseNotYours' }); return null; }
    return payload;
  }

  app.post('/api/explain/improve/create', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    req.auth = auth;
    if (!deps.llmReady) return res.status(503).json({ error: 'Het taalmodel is niet beschikbaar' });
    const { conceptId, courseId = null, lang = 'nl' } = req.body || {};
    if (!conceptId) return res.status(400).json({ error: 'conceptId is vereist' });
    try {
      const { data: concept, error } = await db.from('concepts')
        .select('id, name, definition, course_id, review_status').eq('id', conceptId).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!concept) return res.status(404).json({ error: 'Begrip niet gevonden' });
      const scope = concept.course_id || courseId || null;
      if (!(await gate(req, res, scope))) return;
      if (concept.review_status && concept.review_status !== 'approved'
          && !(await deps.isStaffForCourse(auth.user, auth.profile, scope))) {
        return res.status(404).json({ error: 'Begrip niet gevonden' });
      }
      if (!limiter.take(auth.user.id)) {
        return res.status(429).json({ error: 'Je hebt vandaag het maximum aantal oefeningen gemaakt. Morgen kan het weer.', code: 'dailyLimit' });
      }
      const chunks = (await deps.getChunks(concept, scope)) || [];
      if (chunks.length < MIN_SOURCES) {
        return res.status(422).json({ error: 'Er is te weinig cursusmateriaal over dit begrip voor deze oefening', code: 'notEnoughMaterial' });
      }
      const text = chunks.map(c => c.content).join(' ').toLowerCase();
      const { data: others } = await db.from('concepts').select('name')
        .eq('course_id', scope).eq('review_status', 'approved').limit(2000);
      const related = (others || []).map(o => o.name)
        .filter(n => n && n !== concept.name && n.length > 3 && text.includes(n.toLowerCase())).slice(0, 8);

      const result = await makeExercise({ concept, chunks, related, llmJson: deps.llmJson, lang });
      if (!result.ok) {
        console.log(`[explain/improve] geen oefening voor ${concept.id}: ${result.attempts.map(a => a.reason).join(' | ')}`);
        return res.status(422).json({ error: 'Voor dit begrip lukt het nu niet. Probeer een ander begrip of Leg zelf uit.', code: 'noExercise' });
      }
      const sources = chunks.map((c, i) => ({ index: i + 1, title: c.title || '', documentId: c.documentId || null, excerpt: String(c.content || '').slice(0, 700) }));
      const token = sealExercise({
        v: 1, uid: auth.user.id, course: scope, concept: { id: concept.id, name: concept.name },
        ...result.exercise, sources,
      }, deps.secret);
      return res.json({ text: result.exercise.flawed, token, attempts: result.attempts.length });
    } catch (err) {
      console.error('[explain/improve/create] fout:', err?.message || err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  app.post('/api/explain/improve/evaluate', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    req.auth = auth;
    if (!deps.llmReady) return res.status(503).json({ error: 'Het taalmodel is niet beschikbaar' });
    const payload = openFor(req, res);
    if (!payload) return;
    if (!(await gate(req, res, payload.course))) return;
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
    const lang = req.body?.lang || 'nl';
    if (!answer) return res.status(400).json({ error: 'Schrijf eerst welke fouten je ziet en waarom' });
    if (answer.length > MAX_ANSWER_CHARS) return res.status(400).json({ error: 'Je antwoord is te lang' });
    try {
      const raw = await deps.llmText(evaluationSystem(lang), evaluationUser({ concept: payload.concept.name, payload, answer }), { effort: 'low', maxTokens: 2500 });
      if (!raw) return res.status(502).json({ error: 'De feedback kon niet worden gemaakt. Probeer het opnieuw.' });
      const parsed = parseEvaluation(raw, payload.errors.length);
      return res.json({
        feedback: parsed || { found: null, total: payload.errors.length, foundDetail: '', reasoning: raw, wronglyFlagged: '', nextStep: '' },
        reveal: { correct: payload.correct, errors: payload.errors, sources: payload.sources },
      });
    } catch (err) {
      console.error('[explain/improve/evaluate] fout:', err?.message || err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  // Reflectie in het leerdagboek (alleen op verzoek van de student, en alleen als het dagboek aan staat).
  app.post('/api/explain/improve/reflect', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    req.auth = auth;
    if (!deps.llmReady) return res.status(503).json({ error: 'Het taalmodel is niet beschikbaar' });
    const payload = openFor(req, res);
    if (!payload) return;
    if (!(await gate(req, res, payload.course))) return;
    if (!(await deps.courseFeatureOnFor(auth.user, auth.profile, payload.course, 'journal'))) {
      return res.status(403).json({ error: 'Het leerdagboek wordt in deze cursus niet gebruikt', code: 'feature_disabled', feature: 'journal' });
    }
    const lang = req.body?.lang || 'nl';
    const answer = String(req.body?.answer || '').slice(0, MAX_ANSWER_CHARS);
    const fb = req.body?.feedback || {};
    const feedbackText = [fb.found != null ? `${fb.found}/${payload.errors.length}` : '', fb.foundDetail, fb.reasoning, fb.wronglyFlagged, fb.nextStep]
      .filter(Boolean).map(s => String(s).slice(0, 3000)).join('\n\n');
    const prompt = `Je bent een "critical friend" voor een student. De student deed de oefening "Verbeter deze uitleg" bij het begrip "${payload.concept.name}": in een uitleg zaten ${payload.errors.length} bewust aangebrachte fout(en), en de student moest ze vinden en uitleggen. Schrijf een korte formatieve reflectie, direct gericht aan de student ("je").

Uitleg met fouten:
${payload.flawed}

De fouten waren:
${payload.errors.map((e, i) => `${i + 1}. "${e.sentence}" — ${e.why}`).join('\n')}

Antwoord van de student:
${answer || '(geen)'}

Feedback die de student kreeg:
${feedbackText || '(geen)'}${journalFormatInstruction(lang)}${buildLanguageInstruction(lang)}`;
    try {
      const raw = await deps.llmText('', prompt, { effort: 'low', maxTokens: 900 });
      if (!raw) return res.status(502).json({ error: 'De reflectie kon niet worden gemaakt. Probeer het opnieuw.' });
      const journalCourseId = await deps.resolveJournalCourseId(payload.course, auth.user);
      const { data: entry, error } = await db.from('learning_journal_entries').insert({
        user_id: auth.user.id,
        title: lang === 'nl' ? `Verbeter deze uitleg: ${payload.concept.name}` : `Improve this explanation: ${payload.concept.name}`,
        ...journalFieldsFromModel(raw, lang),
        activity_type: 'explanation_reflection',
        course_id: journalCourseId,
      }).select('id').single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ journalEntryId: entry.id });
    } catch (err) {
      console.error('[explain/improve/reflect] fout:', err?.message || err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });
}
