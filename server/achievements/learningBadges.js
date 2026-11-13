// Badges bij Ik leg uit en de Quiz (besluit 2026-11-12). Een badge beloont
// leren, per begrip uit de cursus, en alleen op bewijs dat de server zelf heeft
// vastgesteld: de score van Ik leg uit, de beoordeling van "Verbeter deze
// uitleg" en de door de server nagekeken quiz (quiz_sessions). Elke badge
// verdien je één keer per begrip (en per medaillekleur). Docenten zien ze niet.
//
// Ik leg uit
//   explain_clear   Helder uitgelegd: score ≥ 80.
//   explain_growth  Gegroeid: na feedback opnieuw uitgelegd, minstens 20 punten
//                   hoger en minstens 70 ("redelijk goed" op de meetlat).
//   explain_flaws   Foutenjager: in "Verbeter deze uitleg" alle fouten gevonden
//                   en uitgelegd, en niets ten onrechte als fout aangewezen.
// Quiz
//   quiz_medal      Brons/zilver/goud (level 1/2/3 = makkelijk/gemiddeld/moeilijk):
//                   quiz ≥ 80% met genoeg vragen, en het begrip zelf ≥ 80%.
//   quiz_mastered   Onder de knie: een begrip goed (≥ 80%, minstens 2 vragen)
//                   in quizzen op twee verschillende dagen.
//   quiz_comeback   Herkansing gelukt: een begrip dat eerder onvoldoende ging
//                   (< 50%), gaat later goed.

import { amsterdamDay } from '../account/tokenBudget.js';

export const BADGE = Object.freeze({
  explainClear: 'explain_clear',
  explainGrowth: 'explain_growth',
  explainFlaws: 'explain_flaws',
  quizMedal: 'quiz_medal',
  quizMastered: 'quiz_mastered',
  quizComeback: 'quiz_comeback',
});

export const EXPLAIN_CLEAR_MIN = 80;
export const EXPLAIN_GROWTH_STEP = 20;
export const EXPLAIN_GROWTH_MIN = 70;
// De vorige uitleg moet al ergens op lijken: een expres lege of onzinnige eerste
// poging telt niet als vertrekpunt voor groei.
export const EXPLAIN_GROWTH_FROM = 30;
export const QUIZ_MEDAL_MIN_PCT = 80;
export const QUIZ_MEDAL_MIN_QUESTIONS = Object.freeze({ mcq: 5, open: 3, casus: 3 });
export const MEDAL_LEVEL = Object.freeze({ easy: 1, medium: 2, hard: 3 });
export const CONCEPT_GOOD_PCT = 80;
export const CONCEPT_GOOD_MIN_QUESTIONS = 2;
export const CONCEPT_WEAK_PCT = 50;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: welke badges horen bij deze beoordeling van Ik leg uit? */
export function explainBadges({ score, previousScore = null }) {
  const s = num(score);
  if (s == null) return [];
  const out = [];
  if (s >= EXPLAIN_CLEAR_MIN) out.push(BADGE.explainClear);
  const prev = num(previousScore);
  if (prev != null && prev >= EXPLAIN_GROWTH_FROM && s >= EXPLAIN_GROWTH_MIN && s - prev >= EXPLAIN_GROWTH_STEP) out.push(BADGE.explainGrowth);
  return out;
}

/** Pure: Foutenjager? Alle bedoelde fouten gevonden en niets ten onrechte aangewezen. */
export function flawHunterEarned(feedback) {
  return !!feedback && Number.isInteger(feedback.found) && feedback.total > 0
    && feedback.found === feedback.total && !String(feedback.wronglyFlagged || '').trim();
}

/** Pure: per begrip hoeveel vragen en welk percentage (meerkeuze 100/0, open de score). */
export function conceptResults(questions, answers) {
  const acc = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!q.conceptId || !a) return;
    const points = a.type === 'mcq' ? (a.isCorrect ? 100 : 0) : num(a.evaluation?.score);
    if (points == null) return;
    const r = (acc[q.conceptId] ||= { total: 0, points: 0 });
    r.total += 1;
    r.points += points;
  });
  return Object.fromEntries(Object.entries(acc).map(([id, r]) => [id, { total: r.total, pct: Math.round(r.points / r.total) }]));
}

const isGood = (r) => !!r && r.total >= CONCEPT_GOOD_MIN_QUESTIONS && r.pct >= CONCEPT_GOOD_PCT;
const isWeak = (r) => !!r && r.total >= 1 && r.pct < CONCEPT_WEAK_PCT;

/**
 * Pure: badges bij een afgeronde quiz.
 * @param {object} p
 * @param {'mcq'|'open'|'casus'} p.questionType
 * @param {'easy'|'medium'|'hard'} p.difficulty
 * @param {number} p.total            aantal vragen
 * @param {number} p.pct              score van de hele quiz
 * @param {Record<string,{total:number,pct:number}>} p.results  per begrip, deze quiz
 * @param {Array<{day:string, results:Record<string,{total:number,pct:number}>}>} p.history  eerdere afgeronde quizzen
 * @param {string} p.today            dag van deze quiz (Amsterdam)
 * @returns {Array<{kind:string, conceptId:string, level:number|null}>}
 */
export function quizBadges({ questionType, difficulty, total, pct, results, history = [], today }) {
  const out = [];
  const medalLevel = MEDAL_LEVEL[difficulty];
  const medalQuiz = medalLevel && total >= (QUIZ_MEDAL_MIN_QUESTIONS[questionType] ?? Infinity) && pct >= QUIZ_MEDAL_MIN_PCT;
  for (const [conceptId, r] of Object.entries(results || {})) {
    if (medalQuiz && r.pct >= QUIZ_MEDAL_MIN_PCT) out.push({ kind: BADGE.quizMedal, conceptId, level: medalLevel });
    if (!isGood(r)) continue;
    if (history.some(h => h.day !== today && isGood(h.results?.[conceptId]))) out.push({ kind: BADGE.quizMastered, conceptId, level: null });
    if (history.some(h => isWeak(h.results?.[conceptId]))) out.push({ kind: BADGE.quizComeback, conceptId, level: null });
  }
  return out;
}

/** Dag in Amsterdam van een tijdstip (voor "op twee verschillende dagen"). */
export const dayOf = (iso) => amsterdamDay(iso ? new Date(iso) : new Date());

/**
 * Kent badges toe; wat de student al heeft, slaat de unieke index over.
 * @param {Array<{kind:string, conceptId:string|null, label:string|null, level?:number|null, details?:object}>} badges
 * @returns {Promise<Array<{kind:string, label:string|null, level:number|null}>>} de nieuwe badges
 */
export async function awardBadges(db, { userId, courseId, badges }) {
  const earned = [];
  if (!db || !userId) return earned;
  for (const b of badges) {
    const row = {
      user_id: userId,
      course_id: courseId || null,
      kind: b.kind,
      concept_id: b.conceptId || null,
      topic_key: b.conceptId ? String(b.conceptId) : '',
      topic_label: b.label || null,
      level: b.level ?? null,
      details: b.details || {},
    };
    const { error } = await db.from('student_achievements').insert(row);
    if (!error) earned.push({ kind: b.kind, label: row.topic_label, level: row.level });
    else if (error.code !== '23505') console.warn('[badges] toekennen mislukt:', error.message);
  }
  return earned;
}
