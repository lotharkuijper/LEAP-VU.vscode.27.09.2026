// Nakijken van een quizantwoord op de server (2026-11-12). Meerkeuze vergelijkt
// de gekozen optie met de bewaarde sleutel; een open vraag of casus beoordeelt
// het taalmodel tegen het modelantwoord en de rubric (formatief: feedback,
// feedforward en een score 0–100). Een numerieke ItemBank-vraag wordt met de
// tolerantie van R/exams (extol) vergeleken; de tekst daarbij maakt de browser.

import { STUDENT_TEXT_RULE, wrapStudentText } from '../lib/studentText.js';
import { extractJSON, secondPersonRule } from './quizQuestions.js';

export const EVALUATE_PROMPT_MODE = 'quiz_evaluate_open';
export const EVALUATE_TEMPERATURE = 0.3;
export const EVALUATE_MAX_TOKENS = 1200;
export const MAX_ANSWER_CHARS = 8000;


/** Meerkeuze: goed of fout. */
export function gradeMcq(q, selectedIndex) {
  return { type: 'mcq', selectedIndex, isCorrect: selectedIndex === q.correctAnswer };
}

/** Een getal uit een vrij tekstantwoord (komma als decimaalteken mag), of null. */
export function parseNumericAnswer(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/** Wordt deze open vraag als getal nagekeken? */
export const isNumericQuestion = (q) => q.extype === 'num' && typeof q.numericExpected === 'number' && Number.isFinite(q.numericExpected);

/**
 * Numeriek nakijken: goed als |antwoord − verwacht| ≤ tolerantie (zonder
 * tolerantie strikt, met een kleine marge voor afrondingsruis). De browser
 * maakt er met `numeric` een leesbare tekst van in de taal van de student.
 */
export function gradeNumeric(q, answerText) {
  const tolerance = Number.isFinite(q.numericTolerance) && q.numericTolerance > 0 ? q.numericTolerance : 0;
  const student = parseNumericAnswer(answerText);
  const numeric = { expected: q.numericExpected, tolerance, student, outcome: 'noNumber' };
  if (student === null) return { feedback: '', feedforward: '', score: 0, numeric };
  const diff = Math.abs(student - q.numericExpected);
  const correct = diff <= (tolerance > 0 ? tolerance : 1e-9);
  return { feedback: '', feedforward: '', score: correct ? 100 : 0, numeric: { ...numeric, outcome: correct ? 'correct' : 'wrong', diff: Number(diff.toPrecision(4)) } };
}

/** De opdracht aan het taalmodel om een open antwoord of casusantwoord te beoordelen. */
export function buildEvaluationPrompt(q, studentAnswer, lang = 'nl') {
  const persona = q.type === 'casus'
    ? 'Je bent een ervaren docent aan de VU Amsterdam en beoordeelt jouw antwoord op een casusvraag. Houd zowel de inhoudelijke juistheid als het correct toepassen op de geschetste casus mee in je oordeel.'
    : 'Je bent een ervaren docent aan de VU Amsterdam en beoordeelt jouw antwoord op een open vraag.';
  const questionBlock = q.type === 'casus'
    ? `Casusbeschrijving:\n${q.context}\n\nVraag bij de casus:\n${q.question}`
    : `Open vraag:\n${q.question}`;
  return `${persona}

${questionBlock}

Modelantwoord (referentie, niet zichtbaar voor de student):
${q.modelAnswer}

Beoordelingscriteria (rubric):
${q.rubric}

Antwoord van jou (de student):
${wrapStudentText(studentAnswer)}

${STUDENT_TEXT_RULE}

${secondPersonRule(lang)}

Schrijf een formatieve beoordeling met EXACT drie velden:
1. "feedback": 3–6 zinnen die concreet benoemen wat goed gaat en wat ontbreekt of onjuist is in jouw antwoord.
2. "feedforward": 2–4 zinnen die concreet beschrijven hoe jij je antwoord een volgende keer kan verbeteren (één concrete vervolgstap, niet vaag).
3. "score": een geheel getal tussen 0 en 100 dat aangeeft hoe volledig en correct jouw antwoord is, gewogen tegen het modelantwoord en de rubric. 0 = compleet onjuist of leeg, 100 = inhoudelijk volledig en correct.

Geef je antwoord UITSLUITEND als één JSON-object met deze structuur, zonder extra tekst en zonder markdown-codeblok:
{
  "feedback": "...",
  "feedforward": "...",
  "score": 75
}`;
}

/** Leest de beoordeling; de score blijft binnen 0–100. */
export function parseEvaluation(content) {
  const parsed = extractJSON(content, 'object');
  return {
    feedback: String(parsed.feedback || '').trim(),
    feedforward: String(parsed.feedforward || '').trim(),
    score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
  };
}
