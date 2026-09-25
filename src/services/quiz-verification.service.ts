/**
 * Kwaliteitscontrole van quizvragen vóórdat een student ze ziet.
 *
 * Uitgangspunt: hoe streng een vraag wordt gecontroleerd hangt NIET af van de
 * bron of van strict-mode bij het genereren. Elke door het taalmodel
 * gegenereerde vraag (RAG, gemengd of creatief) doorloopt dezelfde controle:
 *
 *  1. Structuurcheck (deterministisch): 4 opties, geldige antwoordindex,
 *     modelantwoord/rubric/casus aanwezig, enz.
 *  2. Blind oplossen: het model beantwoordt de vraag zelf — zonder het
 *     officiële antwoord, de uitleg of het modelantwoord te zien — als zeer
 *     kritische toetsdeskundige én vakexpert van de cursus zoals die in het
 *     cursusmateriaal (RAG) is vastgelegd.
 *  3. Vergelijken: het eigen antwoord wordt naast het officiële antwoord en de
 *     feedback/uitleg gelegd en er wordt vastgesteld of de vraag bij de cursus
 *     past. Het oordeel heeft drie niveaus:
 *       - consistent : klopt → goedgekeurd;
 *       - minor      : inhoudelijk juist, maar formulering/rubric/feedback kan
 *                      beter → verbeterde versie wordt geprobeerd, maar de
 *                      (bruikbare) originele vraag blijft als terugval behouden;
 *       - major      : duidelijke discrepantie (ander antwoord, onjuiste of
 *                      tegenstrijdige feedback, dubbelzinnig, niet bij de cursus)
 *                      → verbeteren en opnieuw controleren; lukt dat niet binnen
 *                      MAX_REPAIR_ROUNDS, dan afgekeurd.
 *     Bij MCQ is een ander gekozen antwoord altijd 'major'.
 *
 * ItemBank-vragen zijn al door de maker van de databank getoetst; die krijgen
 * alleen een passendheidscheck: past de vraag bij het cursusmateriaal?
 *
 * Zonder passend cursusmateriaal wordt ELKE vraag afgekeurd (ook ItemBank).
 *
 * Fail-closed: een fout of onleesbaar antwoord van het model tijdens de
 * controle laat de vraag nooit stil door. Zulke technische fouten worden wel
 * APART geteld (kind: 'error'), zodat de UI ze niet als inhoudelijke afkeuring
 * presenteert. Tijdelijke fouten (429/5xx/leeg antwoord) krijgen één herkansing.
 */

import { callChatAPI, extractJSON, LLMError, type QuizQuestion, type MCQQuestion } from './llm.service';

export type ChatCaller = (body: object) => Promise<any>;

export const MAX_REPAIR_ROUNDS = 3;
const VERIFY_TEMPERATURE = 0.1;
const VERIFY_PROMPT_MODE = 'quiz_verify';
const DEFAULT_CONCURRENCY = 4;

export const NO_COURSE_MATERIAL_REASON = 'geen passend cursusmateriaal gevonden';

export function hasCourseMaterial(ragContext: string | undefined): ragContext is string {
  return typeof ragContext === 'string' && ragContext.trim().length > 0;
}

export interface VerificationOutcome {
  status: 'accepted' | 'repaired' | 'rejected';
  question: QuizQuestion | null;
  reason: string;
  /** Alleen bij 'rejected': inhoudelijke afkeuring of technische fout. */
  kind?: 'quality' | 'error';
}

export interface VerificationReport {
  kept: QuizQuestion[];
  accepted: number;
  repaired: number;
  /** Inhoudelijk afgekeurd. */
  rejected: Array<{ question: QuizQuestion; reason: string }>;
  /** Niet te controleren door een technische fout (fail-closed, niet doorgelaten). */
  failed: Array<{ question: QuizQuestion; reason: string }>;
}

interface SolveResult {
  answerable: boolean;
  answerIndex: number | null;
  answer: string;
  reasoning: string;
  problems: string;
}

export type Severity = 'consistent' | 'minor' | 'major';

interface CompareResult {
  verdict: Severity;
  fitsCourse: boolean;
  discrepancy: string;
  repairedQuestion: Partial<QuizQuestion> | null;
}

// ── 1. Structuur ────────────────────────────────────────────────────────────

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** Geeft een reden terug als de vraag structureel ongeldig is, anders null. */
export function checkQuestionStructure(q: QuizQuestion | null | undefined): string | null {
  if (!q || typeof q !== 'object') return 'geen vraag-object';
  if (!nonEmpty(q.question)) return 'lege vraagtekst';
  if (q.type === 'mcq') {
    if (!Array.isArray(q.options) || q.options.length !== 4) return 'MCQ heeft niet precies 4 opties';
    if (!q.options.every(nonEmpty)) return 'MCQ heeft een lege optie';
    const norm = q.options.map(o => o.trim().toLowerCase());
    if (new Set(norm).size !== norm.length) return 'MCQ heeft dubbele opties';
    if (!Number.isInteger(q.correctAnswer) || q.correctAnswer < 0 || q.correctAnswer > 3) {
      return 'MCQ heeft geen geldige antwoordindex (0–3)';
    }
    if (!nonEmpty(q.explanation)) return 'MCQ mist een uitleg';
    return null;
  }
  if (q.type === 'open' || q.type === 'casus') {
    if (!nonEmpty(q.modelAnswer)) return 'modelantwoord ontbreekt';
    if (!nonEmpty(q.rubric)) return 'rubric ontbreekt';
    if (q.type === 'casus' && !nonEmpty(q.context)) return 'casusbeschrijving ontbreekt';
    return null;
  }
  return `onbekend vraagtype: ${String((q as any).type)}`;
}

// ── 2. Prompts ──────────────────────────────────────────────────────────────

const LETTERS = ['A', 'B', 'C', 'D'];

/** De vraag zoals een student hem ziet: zonder antwoord, uitleg of rubric. */
export function blindQuestionText(q: QuizQuestion): string {
  if (q.type === 'mcq') {
    return `${q.question}\n${q.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')}`;
  }
  if (q.type === 'casus') return `Casus:\n${q.context}\n\nVraag:\n${q.question}`;
  return q.question;
}

function courseBlock(ragContext: string, topics: string[]): string {
  const topicLine = topics.length > 0 ? `Onderwerp(en) van de quiz: ${topics.join(', ')}\n\n` : '';
  return `${topicLine}Cursusmateriaal (dit bepaalt het vakgebied, de begrippen, notatie en afspraken van deze cursus):\n"""\n${ragContext}\n"""`;
}

const PERSONA = `Je bent een zeer kritische toetsdeskundige én expert in het vakgebied van deze cursus, zoals dat vakgebied in het meegeleverde cursusmateriaal is vastgelegd. Je laat geen vage, dubbelzinnige, onjuiste, niet-toetsbare of niet bij de cursus passende vraag door. Tegelijk ben je constructief: een vraag die bijna goed is, verbeter je zodat hij wél bruikbaar is.`;

export function buildSolvePrompt(q: QuizQuestion, ragContext: string, topics: string[]): string {
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

function officialAnswerText(q: QuizQuestion): string {
  if (q.type === 'mcq') {
    return `Officieel juist antwoord: ${LETTERS[q.correctAnswer]}. ${q.options[q.correctAnswer]}\nFeedback/uitleg bij dat antwoord: ${q.explanation}`;
  }
  return `Officieel modelantwoord: ${q.modelAnswer}\nBeoordelingsrubric: ${q.rubric}`;
}

export function buildComparePrompt(
  q: QuizQuestion,
  solve: SolveResult,
  ragContext: string,
  topics: string[],
  mcqMismatch: boolean,
): string {
  const mismatchNote = mcqMismatch
    ? `\nLET OP: jouw onafhankelijke antwoord (${solve.answerIndex == null ? 'geen eenduidige optie' : LETTERS[solve.answerIndex]}) wijkt af van het officiële antwoord (${q.type === 'mcq' ? LETTERS[q.correctAnswer] : '?'}). Dat is per definitie "major": lever een verbeterde vraag waarin precies één optie eenduidig juist is.\n`
    : '';
  return `${PERSONA}

${courseBlock(ragContext, topics)}

Je hebt eerder de volgende quizvraag onafhankelijk beantwoord, zonder het officiële antwoord te kennen.

Volledige vraag (inclusief officieel antwoord), als JSON:
${JSON.stringify(q, null, 2)}

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

export function buildItembankFitPrompt(q: QuizQuestion, ragContext: string, topics: string[]): string {
  return `Je bent een toetsdeskundige en vakexpert van deze cursus. De onderstaande vraag komt uit een door vakdocenten samengestelde itembank; de kwaliteit van de vraag zelf is al getoetst. Jij beoordeelt ALLEEN of de vraag past bij het onderwijsmateriaal van deze cursus: gaat hij over stof, begrippen en methoden die in het materiaal behandeld worden, op een vergelijkbaar niveau?

${courseBlock(ragContext, topics)}

Vraag (als JSON):
${JSON.stringify(q, null, 2)}

Geef ALLEEN JSON (geen markdown-codeblok):
{ "fits": true of false, "reason": "korte reden" }`;
}

// ── 3. Parsers ──────────────────────────────────────────────────────────────

function contentOf(resp: any): string {
  return resp?.choices?.[0]?.message?.content || '';
}

export function parseSolve(content: string): SolveResult {
  const raw = extractJSON<any>(content, 'object');
  const idx = raw?.answerIndex;
  return {
    answerable: raw?.answerable !== false,
    answerIndex: Number.isInteger(idx) && idx >= 0 && idx <= 3 ? idx : null,
    answer: typeof raw?.answer === 'string' ? raw.answer : '',
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning : '',
    problems: typeof raw?.problems === 'string' ? raw.problems : '',
  };
}

export function parseCompare(content: string): CompareResult {
  const raw = extractJSON<any>(content, 'object');
  const repaired = raw?.repairedQuestion && typeof raw.repairedQuestion === 'object' ? raw.repairedQuestion : null;
  const v = raw?.verdict;
  // Onbekend oordeel (of het oude "discrepancy") telt als 'major': nooit stil goedkeuren.
  const verdict: Severity = v === 'consistent' || v === 'minor' ? v : 'major';
  return {
    verdict,
    // Alleen een expliciete true telt: ontbreekt het veld, dan is passendheid niet vastgesteld.
    fitsCourse: raw?.fitsCourse === true,
    discrepancy: typeof raw?.discrepancy === 'string' ? raw.discrepancy : '',
    repairedQuestion: repaired,
  };
}

// ── 4. LLM-aanroep met herkansing ───────────────────────────────────────────

class VerifyCallError extends Error {}

// Een server die (nog) niet herstart is na het toevoegen van quiz_verify geeft
// "Onbekende promptMode" (400). De persona staat ook in het bericht zelf, dus
// dan kan de controle zonder beheerde system-prompt door. Eén keer vastgesteld
// → voor de rest van de sessie overslaan.
let promptModeUnsupported = false;
/** Alleen voor tests. */
export function __resetVerifyState() { promptModeUnsupported = false; }

const isTransient = (e: any) =>
  e instanceof LLMError
    ? [0, 408, 429, 500, 502, 503, 504].includes(e.status) || e.code === 'empty_response' || e.code === 'length'
    : true; // netwerkfout e.d.

async function ask(call: ChatCaller, prompt: string, maxTokens: number): Promise<string> {
  const body = (tokens: number) => ({
    model: undefined,
    messages: [{ role: 'user', content: prompt }],
    temperature: VERIFY_TEMPERATURE,
    max_tokens: tokens,
    skipSystemPrompt: true,
    ...(promptModeUnsupported ? {} : { promptMode: VERIFY_PROMPT_MODE }),
  });
  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = contentOf(await call(body(attempt === 0 ? maxTokens : maxTokens * 2)));
      if (content.trim()) return content;
      lastErr = new LLMError('leeg antwoord', 502, 'empty_response');
    } catch (err: any) {
      lastErr = err;
      if (err instanceof LLMError && err.status === 400 && /promptMode/i.test(`${err.message} ${err.rawMessage}`) && !promptModeUnsupported) {
        console.warn('[quiz-verify] server kent promptMode "quiz_verify" niet (herstart nodig?) — controle zonder beheerde system-prompt.');
        promptModeUnsupported = true;
        attempt--; // telt niet als herkansing
        continue;
      }
      if (!isTransient(err)) break;
    }
  }
  throw new VerifyCallError(lastErr?.message || String(lastErr));
}

// ── 5. Orkestratie ──────────────────────────────────────────────────────────

function severityOf(compare: CompareResult, solve: SolveResult, mcqMismatch: boolean): Severity {
  // Een afwijkend MCQ-antwoord, een niet-eenduidige vraag of een vraag die niet
  // bij de cursus past is altijd 'major', ook als het model iets milders zegt.
  if (mcqMismatch || !solve.answerable || !compare.fitsCourse) return 'major';
  return compare.verdict;
}

/**
 * Controleert één door het taalmodel gegenereerde vraag (blind oplossen +
 * vergelijken, met verbeterrondes). Zonder cursusmateriaal altijd afgekeurd.
 */
export async function verifyGeneratedQuestion(
  question: QuizQuestion,
  opts: { ragContext?: string; topics: string[]; call?: ChatCaller; maxRepairRounds?: number; onRepair?: () => void },
): Promise<VerificationOutcome> {
  const ragContext = opts.ragContext;
  if (!hasCourseMaterial(ragContext)) {
    return { status: 'rejected', question: null, reason: NO_COURSE_MATERIAL_REASON, kind: 'quality' };
  }
  const call = opts.call ?? callChatAPI;
  const maxRounds = opts.maxRepairRounds ?? MAX_REPAIR_ROUNDS;
  let current: QuizQuestion = question;
  // Laatste versie die als 'minor' (inhoudelijk juist, bruikbaar) is beoordeeld:
  // terugval als een poging tot verbetering zelf niet door de controle komt.
  let usable: QuizQuestion | null = null;
  let lastReason = '';

  const acceptUsable = (why: string): VerificationOutcome => ({
    status: usable === question ? 'accepted' : 'repaired',
    question: usable,
    reason: why,
  });

  for (let round = 0; round <= maxRounds; round++) {
    const structural = checkQuestionStructure(current);
    if (structural) {
      if (usable) return acceptUsable(`verbetering ongeldig (${structural}); bruikbare versie behouden`);
      return { status: 'rejected', question: null, reason: `structuur: ${structural}`, kind: 'quality' };
    }

    let solve: SolveResult;
    let compare: CompareResult;
    let mcqMismatch = false;
    try {
      solve = parseSolve(await ask(call, buildSolvePrompt(current, ragContext, opts.topics), 1200));
      if (current.type === 'mcq') mcqMismatch = solve.answerIndex !== (current as MCQQuestion).correctAnswer;
      compare = parseCompare(
        await ask(call, buildComparePrompt(current, solve, ragContext, opts.topics, mcqMismatch), 2500),
      );
    } catch (err: any) {
      if (usable) return acceptUsable('controle van verbetering mislukt; bruikbare versie behouden');
      return { status: 'rejected', question: null, reason: `controle mislukt: ${err?.message || String(err)}`, kind: 'error' };
    }

    const severity = severityOf(compare, solve, mcqMismatch);
    if (severity === 'consistent') {
      return {
        status: current === question ? 'accepted' : 'repaired',
        question: current,
        reason: current === question ? 'consistent' : `verbeterd: ${lastReason}`,
      };
    }

    lastReason = compare.discrepancy
      || (mcqMismatch ? 'onafhankelijk antwoord wijkt af van officieel antwoord' : '')
      || solve.problems
      || (!compare.fitsCourse ? 'vraag past niet bij het cursusmateriaal' : '')
      || 'discrepantie tussen eigen antwoord en officiële feedback';

    if (severity === 'minor') usable = current;

    const canRepair = !!compare.repairedQuestion && round < maxRounds;
    if (!canRepair) {
      if (usable) return acceptUsable(`kleine onvolkomenheid: ${lastReason}`);
      return { status: 'rejected', question: null, reason: lastReason, kind: 'quality' };
    }
    // Behoud type en bron-tag; de verbeterde versie gaat opnieuw door de controle.
    opts.onRepair?.();
    current = {
      ...current,
      ...compare.repairedQuestion,
      type: current.type,
      source: current.source,
    } as QuizQuestion;
  }

  if (usable) return acceptUsable(`kleine onvolkomenheid: ${lastReason}`);
  return { status: 'rejected', question: null, reason: lastReason || 'onbekend', kind: 'quality' };
}

/**
 * Passendheidscheck voor ItemBank-vragen. Zonder cursusmateriaal is passendheid
 * niet vast te stellen → afgekeurd.
 */
export async function checkItembankFit(
  question: QuizQuestion,
  opts: { ragContext?: string; topics: string[]; call?: ChatCaller },
): Promise<VerificationOutcome> {
  if (!hasCourseMaterial(opts.ragContext)) {
    return { status: 'rejected', question: null, reason: NO_COURSE_MATERIAL_REASON, kind: 'quality' };
  }
  const call = opts.call ?? callChatAPI;
  let raw: any;
  try {
    raw = extractJSON<any>(
      await ask(call, buildItembankFitPrompt(question, opts.ragContext, opts.topics), 600),
      'object',
    );
  } catch (err: any) {
    return { status: 'rejected', question: null, reason: `controle mislukt: ${err?.message || String(err)}`, kind: 'error' };
  }
  if (raw?.fits === true) {
    return { status: 'accepted', question, reason: raw?.reason || 'past bij cursusmateriaal' };
  }
  return { status: 'rejected', question: null, reason: raw?.reason || 'past niet bij cursusmateriaal', kind: 'quality' };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
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
 * Controleert een lijst vragen en geeft behouden vragen + een rapport terug.
 * `mode` bepaalt de soort controle: 'generated' (volledig) of 'itembank'
 * (alleen passendheid).
 */
export async function verifyQuestions(
  questions: QuizQuestion[],
  mode: 'generated' | 'itembank',
  opts: {
    ragContext?: string;
    topics: string[];
    call?: ChatCaller;
    concurrency?: number;
    /** Voortgang: een vraag gaat een verbeterronde in. */
    onRepair?: () => void;
    /** Voortgang: controle van één vraag is afgerond. */
    onChecked?: (kept: boolean) => void;
  },
): Promise<VerificationReport> {
  const check = mode === 'itembank' ? checkItembankFit : verifyGeneratedQuestion;
  const outcomes = await mapLimited(questions, opts.concurrency ?? DEFAULT_CONCURRENCY, async q => {
    const o = await check(q, opts);
    opts.onChecked?.(o.status !== 'rejected' && !!o.question);
    return o;
  });
  const report: VerificationReport = { kept: [], accepted: 0, repaired: 0, rejected: [], failed: [] };
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
