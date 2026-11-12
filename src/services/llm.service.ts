import type { ReadinessResult } from '../lib/readiness';
import type { AttachmentPayload } from '../lib/chatAttachments';
import type { EarnedBadge } from '../lib/badges';
import type { Lang } from '../i18n/languages';
import { getActiveLang } from '../i18n/activeLang';
import { tStatic } from '../i18n/translations';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Handtekening van de server bij een echt tutorantwoord (telt voor "klaar voor een hoger niveau?"). */
  sig?: string;
}

export interface LLMResponse {
  content: string;
  error?: string;
  /** Alleen bij een readiness-vraag: het oordeel van de server. */
  readiness?: ReadinessResult;
  /** Handtekening van deze beurt (tutorchat); bewaar hem bij het antwoord. */
  turnSig?: string;
}

export class LLMError extends Error {
  status: number;
  code?: string;
  rawMessage: string;
  constructor(message: string, status: number, code?: string, rawMessage?: string) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.rawMessage = rawMessage ?? message;
  }
}

type LlmErrLang = string;

export function llmErrorToDutch(err: unknown, lang: LlmErrLang = 'nl'): { title: string; detail?: string } {
  const tr = (key: string) => tStatic(lang as Lang, key);
  if (err instanceof LLMError) {
    const code = err.code ?? '';
    const raw = (err.rawMessage || err.message || '').toLowerCase();
    if (code === 'context_length_exceeded' || raw.includes('context') && raw.includes('length')) {
      return {
        title: tr('llm.err.contextTooLong.title'),
        detail: tr('llm.err.contextTooLong.detail'),
      };
    }
    if (
      code === 'insufficient_quota' ||
      err.status === 402 ||
      raw.includes('quota') ||
      raw.includes('billing') ||
      raw.includes('exceeded your current quota')
    ) {
      return {
        title: tr('llm.err.quota.title'),
        detail: tr('llm.err.quota.detail'),
      };
    }
    if (code === 'rate_limit_exceeded' || err.status === 429 || raw.includes('rate limit')) {
      return {
        title: tr('llm.err.rateLimit.title'),
        detail: tr('llm.err.rateLimit.detail'),
      };
    }
    if (err.status === 503) {
      return {
        title: tr('llm.err.notConfigured.title'),
        detail: err.rawMessage || tr('llm.err.notConfigured.detail'),
      };
    }
    if (code === 'upstream_unavailable') {
      return {
        title: tr('llm.err.unavailable.title'),
        detail: tr('llm.err.unavailable.detail'),
      };
    }
    if (code === 'empty_response' || code === 'length' || raw.includes('lege reactie') || raw.includes('te weinig tokenruimte')) {
      return {
        title: tr('llm.err.tokenSpace.title'),
        detail: tr('llm.err.tokenSpace.detail'),
      };
    }
    if (err.status >= 500) {
      return {
        title: tr('llm.err.serverError.title'),
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    if (err.status === 401 || err.status === 403 || code === 'invalid_api_key') {
      return {
        title: tr('llm.err.accessDenied.title'),
        detail: tr('llm.err.accessDenied.detail'),
      };
    }
    if (code === 'invalid_request_error' || (err.status >= 400 && err.status < 500)) {
      return {
        title: tr('llm.err.rejected.title'),
        detail: err.rawMessage || `HTTP ${err.status}`,
      };
    }
    return {
      title: tr('llm.err.generic.title'),
      detail: err.rawMessage,
    };
  }
  if (err instanceof Error) {
    return {
      title: tr('llm.err.generic.title'),
      detail: err.message,
    };
  }
  return { title: tr('llm.err.generic.title') };
}

// Eén bron van waarheid: de AI-client gebruikt exact de actieve UI-taal
// (gedeeld via i18n/activeLang). Geen eigen localStorage-default meer, dus
// nooit stilletjes terugvallen op Nederlands wanneer de UI een andere
// (browsergedetecteerde) taal toont.
function _getLang(): Lang {
  return getActiveLang();
}

export async function callChatAPI(body: object): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { supabase } = await import('../lib/supabase');
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  } catch {}
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ lang: _getLang(), ...body }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errObj = errorData?.error;
    const rawMsg = (errObj && (errObj.message || errObj)) || errorData?.message || `API Error: ${response.status}`;
    // Code staat bij Azure-fouten in error.code, bij eigen servermeldingen naast error.
    const code = errObj && typeof errObj === 'object' ? errObj.code : (typeof errorData?.code === 'string' ? errorData.code : undefined);
    throw new LLMError(typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg), response.status, code, typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg));
  }

  return response.json();
}

export async function sendChatMessage(
  messages: Message[],
  context?: string,
  ragStrictMode?: boolean,
  sources?: Array<{ title: string; similarity: number }>,
  learningLevel?: number,
  courseId?: string,
  options?: { readinessCheck?: boolean; attachments?: AttachmentPayload[]; leerlijnUnitId?: string; chatGoal?: string }
): Promise<LLMResponse> {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');

    const data = await callChatAPI({
      model: undefined,
      messages: userMessages,
      context,
      temperature: 0.7,
      top_p: 1,
      stream: false,
      ragStrictMode: ragStrictMode ?? false,
      sources: sources && sources.length > 0 ? sources : undefined,
      learningLevel,
      courseId,
      // Alleen voor de (losse) analytics-module: telt of de tutorchat bewijs vond.
      purpose: 'tutor_chat',
      ...(options?.readinessCheck ? { readinessCheck: true } : {}),
      // Bijlagen (alleen in het geheugen; de server bewaart ze niet).
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      // Leerlijn: het onderdeel waar de student zelf voor koos (anders bepaalt de vraag het).
      ...(options?.leerlijnUnitId ? { leerlijnUnitId: options.leerlijnUnitId } : {}),
      ...(options?.chatGoal ? { chatGoal: options.chatGoal } : {}),
    });

    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new LLMError(tStatic(_getLang(), 'llm.err.emptyAnswer'), 502, 'empty_response', 'empty content');
    }

    return {
      content,
      ...(data.readiness ? { readiness: data.readiness as ReadinessResult } : {}),
      ...(typeof data.turnSig === 'string' ? { turnSig: data.turnSig } : {}),
    };
  } catch (error: any) {
    console.error('[LLM] Error calling chat API:', error);
    // LLMError (afkomstig uit callChatAPI of het lege-antwoord-pad) ongewijzigd
    // doorgeven, zodat de UI status/code/rawMessage kan onderscheiden via
    // llmErrorToDutch (context_length_exceeded, rate_limit, 503, 5xx, ...).
    if (error instanceof LLMError) {
      throw error;
    }
    // Niet-HTTP fouten (bv. netwerkfout) als generieke LLMError doorgeven.
    const msg = error?.message || String(error);
    throw new LLMError(msg, 0, undefined, msg);
  }
}

/** Feedback bij "Ik leg uit" in vier blokken (server/explain/explainFeedback.js). */
export interface ExplainFeedbackSections {
  feedback: string;
  related: Array<{ id: string; name: string; relation: string }>;
  feedforward: string[];
}

export interface ExplainEvaluation {
  /** Badges die de server bij deze beoordeling toekende (server/achievements/learningBadges.js). */
  badges?: EarnedBadge[];
  id: string;
  version: number;
  /** Leesbare tekst van alle blokken (ook voor oudere weergaven en het dagboek). */
  content: string;
  sections: ExplainFeedbackSections | null;
  score: { total: number; reason: string } | null;
}

/**
 * "Ik leg uit": de server bepaalt de instructie (toon van de docent + vaste
 * blokken en meetlat), kiest verwante begrippen uit de cursus, beoordeelt en
 * slaat de uitleg op (POST /api/explain/evaluate). De browser stuurt alleen de
 * uitleg en WELKE cursusfragmenten hij vond; de tekst leest de server zelf.
 */
export async function evaluateExplanation(opts: {
  conceptId: string;
  explanation: string;
  courseId?: string | null;
  /** Id's van de gevonden cursusfragmenten (beste eerst). */
  chunkIds?: string[];
  sources?: Array<{ title: string }>;
}): Promise<ExplainEvaluation> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { supabase } = await import('../lib/supabase');
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  } catch { /* zonder sessie weigert de server */ }
  const response = await fetch('/api/explain/evaluate', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lang: _getLang(),
      conceptId: opts.conceptId,
      explanation: opts.explanation,
      ...(opts.courseId ? { courseId: opts.courseId } : {}),
      chunkIds: opts.chunkIds || [],
      sources: (opts.sources || []).map(s => ({ title: s.title })),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = (typeof data?.error === 'string' && data.error) || `API Error: ${response.status}`;
    throw new LLMError(msg, response.status, undefined, msg);
  }
  if (!data?.content) {
    throw new LLMError(tStatic(_getLang(), 'llm.err.emptyReaction'), 502, 'empty_response', 'empty content');
  }
  return data as ExplainEvaluation;
}

export type QuestionType = 'mcq' | 'open' | 'casus';

// Bron-tag op een quizvraag, gebruikt door de mix-aware generator om aan
// studenten te tonen waar elke vraag vandaan komt.
export type QuizSource = 'rag' | 'itembank' | 'llm';

export interface MCQQuestion {
  type: 'mcq';
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  source?: QuizSource;
}

export interface OpenQuestion {
  type: 'open';
  question: string;
  modelAnswer: string;
  rubric: string;
  source?: QuizSource;
  // Optionele meta-data voor ItemBank-vragen, zodat de evaluator de juiste
  // beoordelingsmethode kan kiezen (numeriek vs tekst/cloze) en in de feedback
  // kan vermelden welke methode is gebruikt (Task #67).
  extype?: 'num' | 'string' | 'cloze' | string;
  numericExpected?: number;
  numericTolerance?: number;
}

export interface CasusQuestion {
  type: 'casus';
  context: string;
  question: string;
  modelAnswer: string;
  rubric: string;
  source?: QuizSource;
}

export type QuizQuestion = MCQQuestion | OpenQuestion | CasusQuestion;

export interface AnswerEvaluation {
  feedback: string;
  feedforward: string;
  score: number; // 0–100
  /** Numerieke ItemBank-vraag: de server vergelijkt het getal; de tekst maakt de browser. */
  numeric?: { expected: number; tolerance: number; student: number | null; outcome: 'correct' | 'wrong' | 'noNumber'; diff?: number };
}

// Quizvragen maken, controleren en nakijken doet sinds 2026-11-12 de server
// (server/quiz/); de browser praat daarmee via services/quiz-session.service.ts.

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  let response: Response;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const { supabase } = await import('../lib/supabase');
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    } catch {}
    response = await fetch('/api/embeddings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts }),
    });
  } catch (error: any) {
    // Echte netwerkfout: er is geen HTTP-status om op te beslissen.
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Error generating embeddings:', msg);
    throw new Error(msg);
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const err = new Error(
      errData.error || `Embeddings API error: ${response.status}`,
    ) as Error & { status?: number; isRateLimit?: boolean };
    err.status = response.status;
    // 429 = Azure-snelheidslimiet (de server heeft zijn eigen retries al uitgeput).
    // Markeer dit expliciet zodat de aanroeper er gecontroleerd op kan wachten en
    // opnieuw proberen, zonder andere fouten (RLS, netwerk, ...) per ongeluk als
    // snelheidslimiet te behandelen.
    err.isRateLimit = response.status === 429;
    console.error('Error generating embeddings:', err.message);
    throw err;
  }

  const data = await response.json();
  return data.embeddings;
}
