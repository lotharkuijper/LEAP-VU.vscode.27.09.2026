/**
 * Kwaliteitscontrole van quizvragen vóórdat een student ze ziet (op de server
 * sinds 2026-11-12; daarvoor in de browser).
 *
 * Hoe streng een vraag wordt gecontroleerd hangt NIET af van de bron of van
 * strict-mode bij het genereren. Elke door het taalmodel gegenereerde vraag
 * doorloopt dezelfde controle:
 *  1. Structuur (deterministisch): 4 opties, geldige antwoordindex, enz.
 *  2. Blind oplossen: het model beantwoordt de vraag zonder het officiële
 *     antwoord te zien, als kritische toetsdeskundige én vakexpert van de cursus.
 *  3. Vergelijken met het officiële antwoord: consistent → goed; minor →
 *     verbeterde versie proberen, de bruikbare vraag blijft terugval; major →
 *     verbeteren en opnieuw controleren, anders afgekeurd. Bij meerkeuze is een
 *     ander gekozen antwoord altijd 'major'.
 * ItemBank-vragen krijgen alleen een passendheidscheck bij het cursusmateriaal.
 * Zonder passend cursusmateriaal wordt ELKE vraag afgekeurd.
 * Fail-closed: een fout tijdens de controle laat de vraag nooit door; zulke
 * technische fouten worden apart geteld (kind 'error'). Tijdelijke fouten
 * krijgen één herkansing.
 *
 * `ask(prompt, maxTokens)` roept het taalmodel aan en geeft de tekst terug.
 */

import { checkQuestionStructure, extractJSON } from './quizQuestions.js';

export const MAX_REPAIR_ROUNDS = 3;
export const VERIFY_TEMPERATURE = 0.1;
export const VERIFY_PROMPT_MODE = 'quiz_verify';
const DEFAULT_CONCURRENCY = 4;

export const NO_COURSE_MATERIAL_REASON = 'geen passend cursusmateriaal gevonden';

export const hasCourseMaterial = (ragContext) => typeof ragContext === 'string' && ragContext.trim().length > 0;

const LETTERS = ['A', 'B', 'C', 'D'];

/** De vraag zoals een student hem ziet: zonder antwoord, uitleg of rubric. */
export function blindQuestionText(q) {
  if (q.type === 'mcq') return `${q.question}\n${q.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')}`;
  if (q.type === 'casus') return `Casus:\n${q.context}\n\nVraag:\n${q.question}`;
  return q.question;
}

function courseBlock(ragContext, topics) {
  const topicLine = topics.length > 0 ? `Onderwerp(en) van de quiz: ${topics.join(', ')}\n\n` : '';
  return `${topicLine}Cursusmateriaal (dit bepaalt het vakgebied, de begrippen, notatie en afspraken van deze cursus):\n"""\n${ragContext}\n"""`;
}

const PERSONA = `Je bent een zeer kritische toetsdeskundige én expert in het vakgebied van deze cursus, zoals dat vakgebied in het meegeleverde cursusmateriaal is vastgelegd. Je laat geen vage, dubbelzinnige, onjuiste, niet-toetsbare of niet bij de cursus passende vraag door. Tegelijk ben je constructief: een vraag die bijna goed is, verbeter je zodat hij wél bruikbaar is.`;

// Interne velden (bron, begrip) horen niet in de vraag die het model beoordeelt.
const forModel = ({ source: _s, conceptId: _c, ...q }) => q;

export function buildSolvePrompt(q, ragContext, topics) {
  const answerSpec = q.type === 'mcq'
    ? `"answerIndex": het nummer van de optie die jij juist vindt (0=A, 1=B, 2=C, 3=D), of null als geen of meer dan één optie juist is,`
    : `"answerIndex": null,`;
  return `${PERSONA}

${courseBlock(ragContext, topics)}

Hieronder staat een quizvraag precies zoals de student hem te zien krijgt. Je krijgt het officiële antwoord bewust NIET te zien.
Onderzoek zelf, stap voor stap en vakinhoudelijk, wat het goede antwoord is. Ga uit van het cursusmateriaal; wijk daar alleen van af als het materiaal zwijgt.

Vraag:
"""
${blindQuestionText(q)}
"""

Geef ALLEEN JSON (geen markdown-codeblok) met deze structuur:
{
  "answerable": true of false (false alleen als de vraag echt dubbelzinnig, onvolledig of niet eenduidig te beantwoorden is),
  ${answerSpec}
  "answer": "jouw antwoord in enkele zinnen",
  "reasoning": "korte vakinhoudelijke onderbouwing",
  "problems": "eventuele problemen met de vraagstelling, of een lege string"
}`;
}

function officialAnswerText(q) {
  if (q.type === 'mcq') {
    return `Officieel juist antwoord: ${LETTERS[q.correctAnswer]}. ${q.options[q.correctAnswer]}\nFeedback/uitleg bij dat antwoord: ${q.explanation}`;
  }
  return `Officieel modelantwoord: ${q.modelAnswer}\nBeoordelingsrubric: ${q.rubric}`;
}

export function buildComparePrompt(q, solve, ragContext, topics, mcqMismatch) {
  const mismatchNote = mcqMismatch
    ? `\nLET OP: jouw onafhankelijke antwoord (${solve.answerIndex == null ? 'geen eenduidige optie' : LETTERS[solve.answerIndex]}) wijkt af van het officiële antwoord (${q.type === 'mcq' ? LETTERS[q.correctAnswer] : '?'}). Dat is per definitie "major": lever een verbeterde vraag waarin precies één optie eenduidig juist is.\n`
    : '';
  return `${PERSONA}

${courseBlock(ragContext, topics)}

Je hebt eerder de volgende quizvraag onafhankelijk beantwoord, zonder het officiële antwoord te kennen.

Volledige vraag (inclusief officieel antwoord), als JSON:
${JSON.stringify(forModel(q), null, 2)}

${officialAnswerText(q)}

Jouw onafhankelijke uitwerking:
- Eenduidig te beantwoorden: ${solve.answerable ? 'ja' : 'nee'}
- Antwoord: ${solve.answer}
- Onderbouwing: ${solve.reasoning}
- Gesignaleerde problemen: ${solve.problems || 'geen'}
${mismatchNote}
Vergelijk jouw uitwerking kritisch met het officiële antwoord en de feedback/uitleg, en beoordeel:
1. Komen ze inhoudelijk overeen? Is de feedback vakinhoudelijk juist en in lijn met het cursusmateriaal?
2. Is de vraag eenduidig en toetsbaar?
3. Past de vraag bij de cursus: gaat hij over stof, begrippen en methoden die in het cursusmateriaal aan de orde komen? Een toepassings- of transfervraag mag een nieuwe situatie schetsen, maar de onderliggende stof moet in het materiaal staan.

Kies één oordeel:
- "consistent": vraag, antwoord en feedback kloppen; hooguit stijlverschillen.
- "minor": antwoord en feedback zijn inhoudelijk juist en de vraag past bij de cursus, maar iets kan beter (formulering, rubric sluit niet helemaal aan op de vraag, feedback onvolledig). De vraag is ook zonder verbetering bruikbaar.
- "major": duidelijke discrepantie — ander antwoord, onjuiste of tegenstrijdige feedback, dubbelzinnige vraag, meerdere juiste opties, of stof die niet in het cursusmateriaal aan de orde komt.

Bij "minor" of "major": lever in "repairedQuestion" een volledig verbeterde vraag met exact dezelfde JSON-velden en hetzelfde "type" als het origineel, in dezelfde taal als het origineel. Verander zo weinig mogelijk: los precies de gevonden problemen op, zodat vraag, antwoord en feedback kloppen en de vraag over de stof uit het cursusmateriaal gaat. Alleen als de vraag echt niet te redden is, zet je "repairedQuestion" op null.

Geef ALLEEN JSON (geen markdown-codeblok):
{
  "verdict": "consistent" of "minor" of "major",
  "fitsCourse": true of false,
  "discrepancy": "korte beschrijving van het probleem, of een lege string",
  "repairedQuestion": null of { ...volledige verbeterde vraag... }
}`;
}

export function buildItembankFitPrompt(q, ragContext, topics) {
  return `Je bent een toetsdeskundige en vakexpert van deze cursus. De onderstaande vraag komt uit een door vakdocenten samengestelde itembank; de kwaliteit van de vraag zelf is al getoetst. Jij beoordeelt ALLEEN of de vraag past bij het onderwijsmateriaal van deze cursus: gaat hij over stof, begrippen en methoden die in het materiaal behandeld worden, op een vergelijkbaar niveau?

${courseBlock(ragContext, topics)}

Vraag (als JSON):
${JSON.stringify(forModel(q), null, 2)}

Geef ALLEEN JSON (geen markdown-codeblok):
{ "fits": true of false, "reason": "korte reden" }`;
}

export function parseSolve(content) {
  const raw = extractJSON(content, 'object');
  const idx = raw?.answerIndex;
  return {
    answerable: raw?.answerable !== false,
    answerIndex: Number.isInteger(idx) && idx >= 0 && idx <= 3 ? idx : null,
    answer: typeof raw?.answer === 'string' ? raw.answer : '',
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning : '',
    problems: typeof raw?.problems === 'string' ? raw.problems : '',
  };
}

export function parseCompare(content) {
  const raw = extractJSON(content, 'object');
  const repaired = raw?.repairedQuestion && typeof raw.repairedQuestion === 'object' ? raw.repairedQuestion : null;
  const v = raw?.verdict;
  return {
    // Onbekend oordeel telt als 'major': nooit stil goedkeuren.
    verdict: v === 'consistent' || v === 'minor' ? v : 'major',
    // Alleen een expliciete true telt: ontbreekt het veld, dan is passendheid niet vastgesteld.
    fitsCourse: raw?.fitsCourse === true,
    discrepancy: typeof raw?.discrepancy === 'string' ? raw.discrepancy : '',
    repairedQuestion: repaired,
  };
}

const isTransient = (e) => (typeof e?.status === 'number'
  ? [0, 408, 429, 500, 502, 503, 504].includes(e.status) || e.code === 'empty_response' || e.code === 'length'
  : true);

/** Taalmodel met één herkansing bij een tijdelijke fout of een leeg antwoord. */
async function askWithRetry(ask, prompt, maxTokens) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await ask(prompt, attempt === 0 ? maxTokens : maxTokens * 2);
      if (String(content || '').trim()) return content;
      lastErr = Object.assign(new Error('Het taalmodel gaf een leeg antwoord tijdens de controle.'), { code: 'empty_response', status: 502 });
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  throw new Error(lastErr?.message || String(lastErr));
}

function severityOf(compare, solve, mcqMismatch) {
  // Afwijkend MCQ-antwoord, niet-eenduidig of niet bij de cursus: altijd 'major'.
  if (mcqMismatch || !solve.answerable || !compare.fitsCourse) return 'major';
  return compare.verdict;
}

/** Controleert één gegenereerde vraag (blind oplossen + vergelijken, met verbeterrondes). */
export async function verifyGeneratedQuestion(question, { ragContext, topics, ask, maxRepairRounds = MAX_REPAIR_ROUNDS, onRepair }) {
  if (!hasCourseMaterial(ragContext)) {
    return { status: 'rejected', question: null, reason: NO_COURSE_MATERIAL_REASON, kind: 'quality' };
  }
  let current = question;
  // Laatste versie die 'minor' (inhoudelijk juist, bruikbaar) was: terugval als
  // een verbetering zelf niet door de controle komt.
  let usable = null;
  let lastReason = '';
  const acceptUsable = (why) => ({ status: usable === question ? 'accepted' : 'repaired', question: usable, reason: why });

  for (let round = 0; round <= maxRepairRounds; round++) {
    const structural = checkQuestionStructure(current);
    if (structural) {
      if (usable) return acceptUsable(`verbetering ongeldig (${structural}); bruikbare versie behouden`);
      return { status: 'rejected', question: null, reason: `structuur: ${structural}`, kind: 'quality' };
    }
    let solve;
    let compare;
    let mcqMismatch = false;
    try {
      solve = parseSolve(await askWithRetry(ask, buildSolvePrompt(current, ragContext, topics), 1200));
      if (current.type === 'mcq') mcqMismatch = solve.answerIndex !== current.correctAnswer;
      compare = parseCompare(await askWithRetry(ask, buildComparePrompt(current, solve, ragContext, topics, mcqMismatch), 2500));
    } catch (err) {
      if (usable) return acceptUsable('controle van verbetering mislukt; bruikbare versie behouden');
      return { status: 'rejected', question: null, reason: `controle mislukt: ${err?.message || String(err)}`, kind: 'error' };
    }

    const severity = severityOf(compare, solve, mcqMismatch);
    if (severity === 'consistent') {
      return { status: current === question ? 'accepted' : 'repaired', question: current, reason: current === question ? 'consistent' : `verbeterd: ${lastReason}` };
    }
    lastReason = compare.discrepancy
      || (mcqMismatch ? 'onafhankelijk antwoord wijkt af van officieel antwoord' : '')
      || solve.problems
      || (!compare.fitsCourse ? 'vraag past niet bij het cursusmateriaal' : '')
      || 'discrepantie tussen eigen antwoord en officiële feedback';
    if (severity === 'minor') usable = current;

    if (!compare.repairedQuestion || round >= maxRepairRounds) {
      if (usable) return acceptUsable(`kleine onvolkomenheid: ${lastReason}`);
      return { status: 'rejected', question: null, reason: lastReason, kind: 'quality' };
    }
    // Type, bron en begrip blijven; de verbeterde versie gaat opnieuw door de controle.
    onRepair?.();
    current = { ...current, ...compare.repairedQuestion, type: current.type, source: current.source, conceptId: current.conceptId };
  }
  if (usable) return acceptUsable(`kleine onvolkomenheid: ${lastReason}`);
  return { status: 'rejected', question: null, reason: lastReason || 'onbekend', kind: 'quality' };
}

/** Passendheidscheck voor ItemBank-vragen. */
export async function checkItembankFit(question, { ragContext, topics, ask }) {
  if (!hasCourseMaterial(ragContext)) {
    return { status: 'rejected', question: null, reason: NO_COURSE_MATERIAL_REASON, kind: 'quality' };
  }
  let raw;
  try {
    raw = extractJSON(await askWithRetry(ask, buildItembankFitPrompt(question, ragContext, topics), 600), 'object');
  } catch (err) {
    return { status: 'rejected', question: null, reason: `controle mislukt: ${err?.message || String(err)}`, kind: 'error' };
  }
  if (raw?.fits === true) return { status: 'accepted', question, reason: raw?.reason || 'past bij cursusmateriaal' };
  return { status: 'rejected', question: null, reason: raw?.reason || 'past niet bij cursusmateriaal', kind: 'quality' };
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Controleert een lijst vragen. mode 'generated' (volledig) of 'itembank'
 * (alleen passendheid). Geeft { kept, accepted, repaired, rejected[], failed[] }.
 */
export async function verifyQuestions(questions, mode, opts) {
  const check = mode === 'itembank' ? checkItembankFit : verifyGeneratedQuestion;
  const outcomes = await mapLimited(questions, opts.concurrency ?? DEFAULT_CONCURRENCY, async (q) => {
    const o = await check(q, opts);
    opts.onChecked?.(o.status !== 'rejected' && !!o.question);
    return o;
  });
  const report = { kept: [], accepted: 0, repaired: 0, rejected: [], failed: [] };
  outcomes.forEach((o, i) => {
    if (o.status === 'rejected' || !o.question) {
      console.warn(`[quiz-verify] vraag ${o.kind === 'error' ? 'niet te controleren' : 'afgekeurd'} (${mode}):`, o.reason);
      (o.kind === 'error' ? report.failed : report.rejected).push({ question: questions[i], reason: o.reason });
      return;
    }
    if (o.status === 'repaired') report.repaired++;
    else report.accepted++;
    report.kept.push(o.question);
  });
  return report;
}
