/**
 * Mix-aware quizgeneratie (Task #57).
 *
 * Coördineert het samenstellen van een quiz uit drie bronnen:
 *  - 'rag'      : LLM met cursusmateriaal als bron
 *  - 'itembank' : meerkeuzevragen uit de ShareStats-itembank
 *  - 'llm'      : LLM zonder bron (creatief)
 *
 * De mix-percentages per cursus worden opgehaald van het server-endpoint
 * en gebruikt om een aantal vragen per bron te bepalen. Voor non-MCQ types
 * (open/casus) wordt de itembank-bron overgeslagen — die bevat alleen
 * meerkeuzevragen.
 */

import { supabase } from '../lib/supabase';
import {
  generateQuiz,
  type QuestionType,
  type QuizQuestion,
  type MCQQuestion,
  type OpenQuestion,
  type QuizSource,
} from './llm.service';
import { verifyQuestions, hasCourseMaterial, type VerificationReport } from './quiz-verification.service';

export interface SourceMix {
  pct_rag: number;
  pct_itembank: number;
  pct_llm: number;
}

export interface MixCounts {
  rag: number;
  itembank: number;
  llm: number;
}

export interface ItembankRawMcqQuestion {
  id: string;
  type: 'mcq';
  source: 'itembank';
  sharestats_id?: string;
  question: string;
  options: Record<string, string>;
  correctAnswer: string;
  explanation: string;
  exsection_path?: string[];
}

export interface ItembankRawOpenQuestion {
  id: string;
  type: 'open';
  source: 'itembank';
  sharestats_id?: string;
  question: string;
  modelAnswer: string;
  explanation?: string;
  exsection_path?: string[];
  // R/exams-meta voor type-specifieke beoordeling (Task #67):
  // - extype 'num' → numerieke tolerantie-check via extol
  // - extype 'string'/'cloze' → tekstuele vergelijking met modelantwoord
  extype?: string;
  numericExpected?: number;
  numericTolerance?: number;
}

export type ItembankRawQuestion = ItembankRawMcqQuestion | ItembankRawOpenQuestion;

export const DEFAULT_MIX: SourceMix = { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };

export async function fetchSourceMix(courseId: string | null): Promise<SourceMix> {
  if (!courseId) return DEFAULT_MIX;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`/api/quiz-sources-mix/${courseId}`, { headers });
    if (!res.ok) return DEFAULT_MIX;
    const data = await res.json();
    return data?.mix || DEFAULT_MIX;
  } catch {
    return DEFAULT_MIX;
  }
}

/**
 * Verdeelt `total` vragen pro rata over drie bronnen, met afronding op de
 * grootste bron zodat de som exact `total` is. Itembank-percentage wordt
 * voor non-MCQ types verplaatst naar LLM (itembank bevat alleen MCQ's).
 */
export function distributeMix(total: number, mix: SourceMix, questionType: QuestionType): MixCounts {
  let { pct_rag, pct_itembank, pct_llm } = mix;
  // ItemBank ondersteunt mcq + open. Voor casus is er geen itembank-bron;
  // dat percentage gaat naar de creatieve LLM-bron.
  if (questionType === 'casus') {
    pct_llm += pct_itembank;
    pct_itembank = 0;
  }
  const sum = pct_rag + pct_itembank + pct_llm;
  if (sum <= 0) return { rag: 0, itembank: 0, llm: total };
  const ragF = (pct_rag / sum) * total;
  const ibF = (pct_itembank / sum) * total;
  const llmF = (pct_llm / sum) * total;
  let rag = Math.floor(ragF);
  let ib = Math.floor(ibF);
  let llm = Math.floor(llmF);
  let used = rag + ib + llm;
  // Verdeel resterende vragen op basis van fractioneel deel.
  const fracs: Array<{ key: 'rag' | 'itembank' | 'llm'; frac: number }> = [
    { key: 'rag', frac: ragF - rag },
    { key: 'itembank', frac: ibF - ib },
    { key: 'llm', frac: llmF - llm },
  ].sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (used < total) {
    const k = fracs[i % fracs.length].key;
    if (k === 'rag') rag++;
    else if (k === 'itembank') ib++;
    else llm++;
    used++;
    i++;
  }
  return { rag, itembank: ib, llm };
}

export async function fetchItembankQuestions(
  courseId: string,
  conceptIds: string[],
  limit: number,
  questionType: QuestionType,
): Promise<Array<MCQQuestion | OpenQuestion>> {
  if (limit <= 0 || conceptIds.length === 0) return [];
  // ItemBank levert alleen mcq en open; casus wordt door de server geweigerd.
  if (questionType !== 'mcq' && questionType !== 'open') return [];
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch('/api/quiz/itembank-questions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ courseId, conceptIds, limit, questionType }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw: ItembankRawQuestion[] = Array.isArray(data?.questions) ? data.questions : [];
    return raw.map(q => q.type === 'open' ? convertItembankOpenQuestion(q) : convertItembankMcqQuestion(q));
  } catch (err) {
    console.warn('[quiz-mix] Itembank-vragen ophalen mislukt:', err);
    return [];
  }
}

/**
 * Converteert het ItemBank-formaat (letter-keys, string-correctAnswer) naar
 * het interne MCQQuestion-formaat (string[]-opties, integer-index).
 */
export function convertItembankMcqQuestion(q: ItembankRawMcqQuestion): MCQQuestion {
  const keys = Object.keys(q.options || {}).sort(); // 'A','B','C','D' alfabetisch
  const options = keys.map(k => q.options[k]);
  const correctIndex = Math.max(0, keys.indexOf(q.correctAnswer));
  return {
    type: 'mcq',
    question: q.question,
    options,
    correctAnswer: correctIndex,
    explanation: q.explanation || '',
    source: 'itembank' as QuizSource,
  };
}

/**
 * Backwards-compatible alias.
 */
export const convertItembankQuestion = convertItembankMcqQuestion;

export function convertItembankOpenQuestion(q: ItembankRawOpenQuestion): OpenQuestion {
  const extype = (q.extype || '').toLowerCase();
  // Type-specifieke rubriek (Task #67). Voor numerieke vragen verwijzen we
  // expliciet naar extol; voor tekst/cloze leggen we de nadruk op het
  // ShareStats-modelantwoord uit de Solution-sectie.
  let rubric: string;
  if (extype === 'num' && typeof q.numericExpected === 'number') {
    const tol = q.numericTolerance && q.numericTolerance > 0
      ? `binnen een tolerantie van ±${q.numericTolerance} (R/exams extol)`
      : 'strikt (geen extol-tolerantie opgegeven)';
    rubric = `- Numeriek antwoord: het verwachte getal is ${q.numericExpected}.\n`
      + `- Beoordeel ${tol}.\n`
      + `- Negeer eenheden, korte toelichting of komma vs. punt; vergelijk alleen het getal.`;
  } else if (extype === 'cloze') {
    rubric = `- Cloze-vraag uit de ItemBank: vergelijk elk deelantwoord met het ShareStats-modelantwoord hieronder.\n`
      + `- Geef alleen volle punten als alle deelantwoorden inhoudelijk kloppen; bij gedeeltelijk juiste invulling proportioneel scoren.\n`
      + `- Wees mild met spelling/notatie zolang de bedoelde term ondubbelzinnig is.`;
  } else if (extype === 'string') {
    rubric = `- Open ItemBank-tekstvraag: het ShareStats-modelantwoord (Solution) is leidend.\n`
      + `- Beoordeel of de kerntermen en kernredeneringen uit het modelantwoord aanwezig zijn.\n`
      + `- Accepteer synoniemen of een eigen verwoording, mits de vakinhoud klopt.`;
  } else if (q.explanation && q.explanation.trim().length > 0) {
    // Fallback: gebruik de Solution-tekst als rubriek wanneer extype onbekend
    // is, maar maak expliciet dat het uit de ItemBank komt.
    rubric = `Vergelijk het studentantwoord met het ShareStats-modelantwoord uit de ItemBank:\n${q.explanation.trim()}`;
  } else {
    rubric = 'Beoordeel of het antwoord van de student inhoudelijk overeenkomt met het modelantwoord uit de ItemBank.';
  }

  return {
    type: 'open',
    question: q.question,
    modelAnswer: q.modelAnswer || '',
    rubric,
    source: 'itembank' as QuizSource,
    extype: q.extype,
    numericExpected: q.numericExpected,
    numericTolerance: q.numericTolerance,
  };
}

/** Maximaal aantal genereer+controleer-rondes per bron om afgekeurde vragen te vervangen. */
export const MAX_FILL_ROUNDS = 3;

/**
 * - 'ok'                 : precies het gevraagde aantal gecontroleerde vragen.
 * - 'no_course_material' : geen passend cursusmateriaal → geen enkele vraag
 *                          kan bij de cursus worden getoetst, dus geen quiz.
 * - 'shortfall'          : ook na alle vervangrondes te weinig goedgekeurde vragen.
 */
export type MixedQuizStatus = 'ok' | 'no_course_material' | 'shortfall';

/** Voortgang voor de wachtbalk in de UI. */
export type QuizProgressPhase = 'writing' | 'checking' | 'repairing' | 'replacing' | 'done';
export interface QuizProgressEvent {
  phase: QuizProgressPhase;
  /** Aantal tot nu toe goedgekeurde vragen (voorlopig, vóór ontdubbelen). */
  approved: number;
  target: number;
}

/** Samenvatting van de kwaliteitscontrole over alle bronnen, voor de UI. */
export interface VerificationSummary {
  accepted: number;
  repaired: number;
  /** Inhoudelijk afgekeurd. */
  rejected: number;
  /** Niet te controleren door een technische fout (niet doorgelaten). */
  failed: number;
  /** Laatste technische foutmelding, voor de "technische details" in de UI. */
  lastError?: string;
}

function emptyVerificationSummary(): VerificationSummary {
  return { accepted: 0, repaired: 0, rejected: 0, failed: 0 };
}

function addToSummary(sum: VerificationSummary, r: VerificationReport) {
  sum.accepted += r.accepted;
  sum.repaired += r.repaired;
  sum.rejected += r.rejected.length;
  sum.failed += r.failed.length;
  if (r.failed.length > 0) sum.lastError = r.failed[r.failed.length - 1].reason;
}

// Vervangvragen mogen geen kopie zijn van een vraag die al in de quiz zit.
const questionKey = (q: QuizQuestion) => (q.question || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Genereer een quiz die de bronnen-mix respecteert. Elke vraag doorloopt de
 * kwaliteitscontrole (quiz-verification.service); afgekeurde vragen worden
 * vervangen tot het gevraagde aantal is bereikt. Vragen worden in een
 * willekeurige volgorde geretourneerd en hebben elk een `source`-tag.
 */
export async function generateMixedQuiz(args: {
  courseId: string | null;
  conceptIds: string[];
  topicNames: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  questionType: QuestionType;
  numQuestions: number;
  ragContext?: string;
  ragStrictMode?: boolean;
  mix?: SourceMix;
  onProgress?: (e: QuizProgressEvent) => void;
}): Promise<{
  questions: QuizQuestion[];
  counts: MixCounts;
  effectiveMix: SourceMix;
  verification: VerificationSummary;
  status: MixedQuizStatus;
}> {
  const mix = args.mix || (await fetchSourceMix(args.courseId));
  const verification = emptyVerificationSummary();

  // Zonder passend cursusmateriaal zou elke vraag worden afgekeurd; sla de
  // (dure) generatie dan helemaal over en meld het eerlijk.
  if (!hasCourseMaterial(args.ragContext)) {
    return {
      questions: [],
      counts: { rag: 0, itembank: 0, llm: 0 },
      effectiveMix: mix,
      verification,
      status: 'no_course_material',
    };
  }

  const target = args.numQuestions;
  const counts = distributeMix(target, mix, args.questionType);

  // Task #412: geef de beheerde quiz-prompt-NAAM per bron door aan generateQuiz;
  // de server resolvet die naam server-side naar de vertrouwde prompt (default +
  // actieve DB-override). Strict bij strict-mode, anders blended bij de
  // RAG-bron, en creative bij de LLM-bron.
  const ragPersona = args.ragStrictMode ? 'quiz_generate_strict' : 'quiz_generate_blended';
  const llmPersona = 'quiz_generate_creative';
  // Het cursusmateriaal gaat bij ÉLKE controle mee — ook bij creatieve vragen —
  // zodat de controleur als vakexpert van déze cursus oordeelt.
  let approved = 0;
  const progress = (phase: QuizProgressPhase) => {
    try { args.onProgress?.({ phase, approved: Math.min(approved, target), target }); } catch { /* UI-fout mag de quiz niet breken */ }
  };
  const verifyOpts = {
    ragContext: args.ragContext,
    topics: args.topicNames,
    onRepair: () => progress('repairing'),
    onChecked: (kept: boolean) => { if (kept) approved++; progress('checking'); },
  };
  const seen = new Set<string>();

  // 1) ItemBank — alleen passendheid bij het cursusmateriaal controleren.
  const itembankKept: QuizQuestion[] = [];
  if (counts.itembank > 0 && args.courseId) {
    progress('checking');
    const ibQs = await fetchItembankQuestions(args.courseId, args.conceptIds, counts.itembank, args.questionType);
    const report = await verifyQuestions(ibQs, 'itembank', verifyOpts);
    addToSummary(verification, report);
    for (const q of report.kept) {
      if (itembankKept.length >= counts.itembank || seen.has(questionKey(q))) continue;
      seen.add(questionKey(q));
      itembankKept.push(q);
    }
  }

  // Genereer + controleer tot `needed` goedgekeurde vragen voor deze bron, met
  // hooguit MAX_FILL_ROUNDS rondes. Afgekeurde vragen worden zo vervangen.
  const fill = async (source: 'rag' | 'llm', needed: number): Promise<QuizQuestion[]> => {
    const kept: QuizQuestion[] = [];
    for (let round = 0; round < MAX_FILL_ROUNDS && kept.length < needed; round++) {
      const n = needed - kept.length;
      progress(round === 0 ? 'writing' : 'replacing');
      let candidates: QuizQuestion[];
      try {
        candidates = await generateQuiz(
          args.topicNames,
          args.difficulty,
          args.questionType,
          n,
          source === 'rag' ? args.ragContext : undefined,
          source === 'rag' ? args.ragStrictMode : false,
          source === 'rag' ? ragPersona : llmPersona,
        );
      } catch (err) {
        console.warn(`[quiz-mix] ${source}-bron genereren mislukt (ronde ${round + 1}):`, err);
        continue;
      }
      candidates = candidates.filter(q => !seen.has(questionKey(q))).slice(0, n);
      candidates.forEach(q => { (q as MCQQuestion).source = source; });
      progress('checking');
      const report = await verifyQuestions(candidates, 'generated', verifyOpts);
      addToSummary(verification, report);
      for (const q of report.kept) {
        if (kept.length >= needed || seen.has(questionKey(q))) continue;
        seen.add(questionKey(q));
        kept.push(q);
      }
    }
    return kept;
  };

  // 2) RAG en creatief parallel (scheelt wachttijd). Een tekort aan
  // ItemBank-vragen wordt, zoals voorheen, door de creatieve bron aangevuld.
  const llmPlanned = counts.llm + (counts.itembank - itembankKept.length);
  const [ragKept, llmKept] = await Promise.all([
    counts.rag > 0 ? fill('rag', counts.rag) : Promise.resolve([]),
    llmPlanned > 0 ? fill('llm', llmPlanned) : Promise.resolve([]),
  ]);

  // 3) Nog steeds te weinig? Vul aan uit de bronnen die de docent in de mix
  // heeft opgenomen (cursusmateriaal eerst), zodat de student precies het
  // gevraagde aantal krijgt.
  const topUpSources: Array<'rag' | 'llm'> = [];
  if (counts.rag > 0) topUpSources.push('rag');
  if (llmPlanned > 0 || topUpSources.length === 0) topUpSources.push('llm');
  for (const src of topUpSources) {
    const missing = target - (itembankKept.length + ragKept.length + llmKept.length);
    if (missing <= 0) break;
    (src === 'rag' ? ragKept : llmKept).push(...(await fill(src, missing)));
  }

  const out = [...itembankKept, ...ragKept, ...llmKept];
  approved = out.length;
  progress('done');
  // Shuffle voor afwisseling van bronnen tijdens de quiz.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  // Rapporteer de werkelijk geleverde aantallen per bron — niet de geplande.
  return {
    questions: out,
    counts: { rag: ragKept.length, itembank: itembankKept.length, llm: llmKept.length },
    effectiveMix: mix,
    verification,
    status: out.length === target ? 'ok' : 'shortfall',
  };
}

export const SOURCE_LABELS: Record<QuizSource, string> = {
  rag: 'Cursusmateriaal',
  itembank: 'ItemBank',
  llm: 'LLM-creatief',
};

export const SOURCE_COLORS: Record<QuizSource, string> = {
  rag: 'bg-blue-50 text-blue-700 border-blue-200',
  itembank: 'bg-purple-50 text-purple-700 border-purple-200',
  llm: 'bg-amber-50 text-amber-700 border-amber-200',
};
