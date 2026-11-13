/**
 * De quiz via de server (2026-11-12). De server stelt de quiz samen, bewaart de
 * antwoordsleutel en kijkt na (server/quiz/quizSessionRoutes.js). De browser
 * krijgt een vraag zonder juist antwoord, uitleg of modelantwoord; die komen
 * pas mee nadat de student heeft geantwoord.
 */

import { supabase } from '../lib/supabase';
import { getActiveLang } from '../i18n/activeLang';
import { tStatic } from '../i18n/translations';
import type { Lang } from '../i18n/languages';
import {
  LLMError,
  type AnswerEvaluation,
  type QuestionType,
  type QuizQuestion,
  type QuizSource,
} from './llm.service';
import type { MixCounts, QuizProgressPhase, VerificationSummary } from './quiz-mix.service';
import type { EarnedBadge } from '../lib/badges';

export type QuizSessionStatus = 'ok' | 'no_course_material' | 'shortfall';

export interface PublicQuestion {
  index: number;
  type: QuestionType;
  question: string;
  source: QuizSource | null;
  options?: string[];
  context?: string;
  extype?: string;
}

export interface QuizSessionResult {
  status: QuizSessionStatus;
  sessionId?: string;
  /** Vragen zoals de student ze ziet (bij een proefvraag van een docent: volledig). */
  questions: QuizQuestion[];
  counts: MixCounts;
  verification: VerificationSummary;
  contextStats: { used: number; total: number; charTrimmed: boolean };
}

export type QuizAnswer =
  | { type: 'mcq'; selectedIndex: number; isCorrect: boolean }
  | { type: 'open' | 'casus'; text: string; evaluation: AnswerEvaluation | null };

async function headers(json = true): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const h: Record<string, string> = { 'x-leap-lang': getActiveLang() };
  if (json) h['Content-Type'] = 'application/json';
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

async function failure(res: Response): Promise<LLMError> {
  const data = await res.json().catch(() => ({}));
  const msg = (typeof data?.error === 'string' && data.error) || `HTTP ${res.status}`;
  return new LLMError(msg, res.status, typeof data?.code === 'string' ? data.code : undefined, msg);
}

/** Vraag zonder sleutel → het vraagformaat van de pagina; de sleutel volgt na het antwoord. */
export function fromPublicQuestion(q: PublicQuestion): QuizQuestion {
  const source = q.source || undefined;
  if (q.type === 'mcq') return { type: 'mcq', question: q.question, options: q.options || [], correctAnswer: -1, explanation: '', source };
  if (q.type === 'casus') return { type: 'casus', context: q.context || '', question: q.question, modelAnswer: '', rubric: '', source };
  return { type: 'open', question: q.question, modelAnswer: '', rubric: '', source, extype: q.extype };
}

/**
 * Stelt een quiz samen. De server meldt de voortgang per regel (NDJSON).
 * `tryout`: een docent probeert één vraag uit (met sleutel, niets bewaard).
 */
export async function startQuizSession(
  args: {
    courseId: string;
    conceptIds: string[];
    difficulty: 'easy' | 'medium' | 'hard';
    questionType: QuestionType;
    numQuestions: number;
    chunkIds: string[];
    tryout?: boolean;
  },
  onProgress?: (e: { phase: QuizProgressPhase; approved: number; target: number }) => void,
): Promise<QuizSessionResult> {
  const res = await fetch('/api/quiz/sessions', {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify({ ...args, lang: getActiveLang() }),
  });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new LLMError(tStatic(getActiveLang(), 'quiz.errorGenerating'), 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: QuizSessionResult | null = null;
  let streamError: { message: string; detail?: string } | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'progress') onProgress?.({ phase: event.phase, approved: event.approved, target: event.target });
    else if (event.type === 'error') streamError = { message: event.error, detail: event.detail };
    else if (event.type === 'done') {
      const questions: QuizQuestion[] = (event.questions || []).map((q: PublicQuestion | QuizQuestion) =>
        (args.tryout ? (q as QuizQuestion) : fromPublicQuestion(q as PublicQuestion)));
      done = {
        status: event.status,
        sessionId: event.sessionId,
        questions,
        counts: event.counts || { rag: 0, itembank: 0, llm: 0 },
        verification: event.verification || { accepted: 0, repaired: 0, rejected: 0, failed: 0 },
        contextStats: event.contextStats || { used: 0, total: 0, charTrimmed: false },
      };
    }
    // 'ping' houdt de verbinding open.
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    if (end) break;
  }
  handle(buffer);
  if (streamError) {
    const e = streamError as { message: string; detail?: string };
    throw new LLMError(e.message, 502, undefined, e.detail || e.message);
  }
  if (!done) throw new LLMError(tStatic(getActiveLang(), 'quiz.errorGenerating'), 502);
  return done;
}

/** Revealed: wat de server na het antwoord over de vraag vrijgeeft. */
export type QuestionReveal = { correctAnswer: number; explanation: string } | { modelAnswer: string; rubric: string };

/** Eén antwoord laten nakijken. Het eerste antwoord op een vraag telt. */
export async function answerQuizQuestion(
  sessionId: string,
  index: number,
  answer: { selectedIndex: number } | { text: string },
): Promise<{ answer: QuizAnswer; reveal: QuestionReveal }> {
  const res = await fetch(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify({ index, ...answer, lang: getActiveLang() }),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Quiz afronden: de server bewaart de poging en kent badges toe. */
export async function finishQuizSession(sessionId: string): Promise<{ attemptId: string | null; scorePercentage: number; badges: EarnedBadge[] }> {
  const res = await fetch(`/api/quiz/sessions/${encodeURIComponent(sessionId)}/finish`, {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify({}),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

/**
 * Leesbare beoordeling. Bij een numerieke ItemBank-vraag maakt de browser de
 * tekst (in de taal van de student); bij een andere ItemBank-vraag staat erbij
 * hoe er is nagekeken (Task #67).
 */
export function presentEvaluation(evaluation: AnswerEvaluation, question: QuizQuestion, modelAnswer: string, lang: Lang): AnswerEvaluation {
  const n = evaluation.numeric;
  if (n) {
    const tolNote = n.tolerance > 0 ? tStatic(lang, 'quiz.numericEval.toleranceSuffix', { tol: n.tolerance }) : '';
    const expected = `${n.expected}${tolNote}`;
    const method = n.tolerance > 0
      ? tStatic(lang, 'quiz.numericEval.methodTolerance', { tol: n.tolerance })
      : tStatic(lang, 'quiz.numericEval.methodStrict');
    const model = modelAnswer.trim() ? tStatic(lang, 'quiz.numericEval.modelExplanation', { model: modelAnswer.trim() }) : '';
    if (n.outcome === 'noNumber') {
      return { ...evaluation, feedback: tStatic(lang, 'quiz.numericEval.noNumberFeedback', { expected, method, model }), feedforward: tStatic(lang, 'quiz.numericEval.noNumberFeedforward', { expected: n.expected }) };
    }
    if (n.outcome === 'correct') {
      return { ...evaluation, feedback: tStatic(lang, 'quiz.numericEval.correctFeedback', { student: n.student ?? '', expected, method, model }), feedforward: tStatic(lang, 'quiz.numericEval.correctFeedforward') };
    }
    return { ...evaluation, feedback: tStatic(lang, 'quiz.numericEval.wrongFeedback', { student: n.student ?? '', expected, diff: n.diff ?? '', method, model }), feedforward: tStatic(lang, 'quiz.numericEval.wrongFeedforward') };
  }
  if (question.type === 'open' && question.source === 'itembank') {
    const note = question.extype === 'cloze' ? tStatic(lang, 'quiz.itembankEval.methodCloze') : tStatic(lang, 'quiz.itembankEval.methodOpen');
    return { ...evaluation, feedback: evaluation.feedback ? `${evaluation.feedback}\n\n${note}` : note };
  }
  return evaluation;
}
