// Een quiz samenstellen op de server (2026-11-12; daarvoor in de browser).
//
// De browser zoekt het cursusmateriaal op en geeft alleen door WELKE fragmenten
// het zijn; de server leest de tekst zelf, alleen uit materiaal van deze cursus
// dat voor de quiz mag (server/rag/courseContext.js). Daarna stelt de server de quiz samen
// volgens de bronnen-mix van de docent (composeQuiz): ItemBank, vragen uit het
// cursusmateriaal en creatieve vragen, elk door de kwaliteitscontrole
// (quizVerify.js), met vervangrondes tot het gevraagde aantal er is.

import { distributeMix } from './quizSourcesMix.js';
import { conceptForQuestion } from './quizQuestions.js';
import { verifyQuestions, hasCourseMaterial } from './quizVerify.js';

export const MAX_FILL_ROUNDS = 3;
export const MAX_QUESTIONS = Object.freeze({ mcq: 10, open: 6, casus: 6 });

const questionKey = (q) => String(q.question || '').trim().toLowerCase().replace(/\s+/g, ' ');

const emptySummary = () => ({ accepted: 0, repaired: 0, rejected: 0, failed: 0 });
function addToSummary(sum, report) {
  sum.accepted += report.accepted;
  sum.repaired += report.repaired;
  sum.rejected += report.rejected.length;
  sum.failed += report.failed.length;
  if (report.failed.length > 0) sum.lastError = report.failed[report.failed.length - 1].reason;
}

/**
 * Stelt de quiz samen volgens de mix. Status: 'ok' (precies het gevraagde
 * aantal), 'no_course_material' (geen passend materiaal: geen enkele vraag is
 * bij de cursus te toetsen) of 'shortfall' (te weinig goedgekeurde vragen).
 *
 * @param {object} p
 * @param {Array<{id:string,name:string}>} p.concepts
 * @param {(source:'rag'|'llm', n:number) => Promise<object[]>} p.generate
 * @param {(n:number) => Promise<object[]>} p.pickItembank
 * @param {(prompt:string, maxTokens:number) => Promise<string>} p.ask  controle
 * @param {(e:{phase:string, approved:number, target:number}) => void} [p.onProgress]
 */
export async function composeQuiz({ concepts, questionType, count, ragContext, mix, generate, pickItembank, ask, onProgress }) {
  const verification = emptySummary();
  const counts = { rag: 0, itembank: 0, llm: 0 };
  if (!hasCourseMaterial(ragContext)) return { questions: [], counts, verification, status: 'no_course_material' };

  const topics = concepts.map(c => c.name);
  const planned = distributeMix(count, mix, questionType);
  let approved = 0;
  const progress = (phase) => { try { onProgress?.({ phase, approved: Math.min(approved, count), target: count }); } catch { /* voortgang mag de quiz niet breken */ } };
  const verifyOpts = {
    ragContext, topics, ask,
    onRepair: () => progress('repairing'),
    onChecked: (kept) => { if (kept) approved++; progress('checking'); },
  };
  const seen = new Set();
  const keep = (list, q, max) => {
    if (list.length >= max || seen.has(questionKey(q))) return;
    seen.add(questionKey(q));
    list.push(q);
  };

  // 1) ItemBank: alleen passendheid bij het cursusmateriaal.
  const itembankKept = [];
  if (planned.itembank > 0) {
    progress('checking');
    const report = await verifyQuestions(await pickItembank(planned.itembank), 'itembank', verifyOpts);
    addToSummary(verification, report);
    for (const q of report.kept) keep(itembankKept, q, planned.itembank);
  }

  // Genereren + controleren tot `needed` goedgekeurde vragen, hooguit MAX_FILL_ROUNDS rondes.
  const fill = async (source, needed) => {
    const kept = [];
    for (let round = 0; round < MAX_FILL_ROUNDS && kept.length < needed; round++) {
      const n = needed - kept.length;
      progress(round === 0 ? 'writing' : 'replacing');
      let candidates;
      try {
        candidates = await generate(source, n);
      } catch (err) {
        console.warn(`[quiz] ${source}-bron genereren mislukt (ronde ${round + 1}):`, err?.message || err);
        continue;
      }
      candidates = candidates.filter(q => !seen.has(questionKey(q))).slice(0, n).map(q => ({ ...q, source }));
      progress('checking');
      const report = await verifyQuestions(candidates, 'generated', verifyOpts);
      addToSummary(verification, report);
      for (const q of report.kept) keep(kept, q, needed);
    }
    return kept;
  };

  // 2) Cursusmateriaal en creatief tegelijk; een tekort aan ItemBank-vragen vullen de creatieve vragen aan.
  const llmPlanned = planned.llm + (planned.itembank - itembankKept.length);
  const [ragKept, llmKept] = await Promise.all([
    planned.rag > 0 ? fill('rag', planned.rag) : Promise.resolve([]),
    llmPlanned > 0 ? fill('llm', llmPlanned) : Promise.resolve([]),
  ]);

  // 3) Nog te weinig? Aanvullen uit de bronnen in de mix (cursusmateriaal eerst).
  const topUp = [];
  if (planned.rag > 0) topUp.push('rag');
  if (llmPlanned > 0 || topUp.length === 0) topUp.push('llm');
  for (const src of topUp) {
    const missing = count - (itembankKept.length + ragKept.length + llmKept.length);
    if (missing <= 0) break;
    (src === 'rag' ? ragKept : llmKept).push(...(await fill(src, missing)));
  }

  const out = [...itembankKept, ...ragKept, ...llmKept];
  approved = out.length;
  progress('done');
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  const questions = out.map(q => ({ ...q, conceptId: conceptForQuestion(q, concepts) }));
  return {
    questions,
    counts: { rag: ragKept.length, itembank: itembankKept.length, llm: llmKept.length },
    verification,
    status: out.length === count ? 'ok' : 'shortfall',
  };
}

/** Pure: score van een quiz (meerkeuze 100/0, open de beoordeling), zoals voorheen in de browser. */
export function scoreQuiz(questions, answers) {
  let total = 0;
  let answered = 0;
  let correct = 0;
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    if (a.type === 'mcq') { answered++; if (a.isCorrect) { correct++; total += 100; } }
    else if (a.evaluation && typeof a.evaluation.score === 'number') { answered++; total += a.evaluation.score; }
  });
  return { answered, correct, pct: answered === 0 ? 0 : Math.round(total / answered) };
}

/** Wat er in quiz_attempts.questions_data komt: de vraag zoals de student hem na afloop terugziet. */
export const questionForHistory = ({ conceptId: _c, topic: _t, ...q }) => q;
