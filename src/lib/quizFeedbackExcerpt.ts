import { type ChatExcerptAttachment } from '../components/ChatExcerptCard';
import type { QuizQuestion, AnswerEvaluation } from '../services/llm.service';

// Bouwt van een beantwoorde quizvraag + de feedback een Studiecafé-bijlage
// ("Klopt dit wel?"), in hetzelfde chat_excerpt-formaat als de chat gebruikt.
// Puur (geen i18n-hook): de aanroeper geeft vertaalde labels mee.

export interface QuizExcerptLabels {
  heading: string;
  source: string;
  casus: string;
  yourAnswer: string;
  correctAnswer: string;
  feedback: string;
  feedforward: string;
  score: string;
  modelAnswer: string;
  noAnswer: string;
}

export type QuizExcerptAnswer =
  | { type: 'mcq'; selectedIndex: number }
  | { type: 'open' | 'casus'; text: string; evaluation: AnswerEvaluation | null };

// Server begrenst bijlage-inhoud op 12000 tekens; blijf daar ruim onder.
const MAX_CONTENT = 11000;
const letter = (i: number) => String.fromCharCode(65 + i);

export function buildQuizFeedbackExcerpt(args: {
  question: QuizQuestion;
  answer: QuizExcerptAnswer | undefined;
  labels: QuizExcerptLabels;
  sourceLabel?: string;
  sources?: Array<{ title: string; documentId?: string }>;
  courseId?: string | null;
}): ChatExcerptAttachment {
  const { question: q, answer: a, labels: L } = args;
  const lines: string[] = [];
  lines.push(`**${L.heading}**${args.sourceLabel ? ` · ${L.source}: ${args.sourceLabel}` : ''}`);
  lines.push('');
  if (q.type === 'casus') {
    lines.push(`> **${L.casus}:** ${q.context.replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  lines.push(q.question);

  if (q.type === 'mcq') {
    lines.push('');
    q.options.forEach((o, i) => lines.push(`- **${letter(i)}.** ${o}`));
    lines.push('');
    const sel = a && a.type === 'mcq' ? a.selectedIndex : -1;
    lines.push(`**${L.yourAnswer}:** ${sel >= 0 && sel < q.options.length ? `${letter(sel)}. ${q.options[sel]}` : L.noAnswer}`);
    lines.push(`**${L.correctAnswer}:** ${letter(q.correctAnswer)}. ${q.options[q.correctAnswer] ?? ''}`);
    lines.push(`**${L.feedback}:** ${q.explanation}`);
  } else {
    const free = a && a.type !== 'mcq' ? a : undefined;
    lines.push('');
    lines.push(`**${L.yourAnswer}:** ${free?.text?.trim() || L.noAnswer}`);
    if (free?.evaluation) {
      lines.push(`**${L.score}:** ${free.evaluation.score}/100`);
      lines.push(`**${L.feedback}:** ${free.evaluation.feedback}`);
      if (free.evaluation.feedforward) lines.push(`**${L.feedforward}:** ${free.evaluation.feedforward}`);
    }
    if (q.modelAnswer) lines.push(`**${L.modelAnswer}:** ${q.modelAnswer}`);
  }

  let content = lines.join('\n');
  if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + '…';

  return {
    type: 'chat_excerpt',
    content,
    sources: (args.sources ?? []).slice(0, 12).map((s, i) => ({
      index: i + 1,
      title: s.title,
      ...(s.documentId ? { documentId: s.documentId } : {}),
    })),
    meta: {
      module: 'quiz',
      ...(args.courseId ? { courseId: args.courseId } : {}),
      capturedAt: new Date().toISOString(),
    },
  };
}
