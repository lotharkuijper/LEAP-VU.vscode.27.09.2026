import { type ChatExcerptAttachment } from '../components/ChatExcerptCard';
import type { ExplainFeedbackSections } from '../services/llm.service';

// Bouwt van een eigen uitleg ("Leg zelf uit") + de feedback een Studiecafé-
// bijlage ("Klopt dit wel?"), in hetzelfde chat_excerpt-formaat als de chat en
// de quiz. Puur (geen i18n-hook): de aanroeper geeft vertaalde labels mee.

export interface ExplainExcerptLabels {
  heading: string;
  yourExplanation: string;
  feedback: string;
  score: string;
  related: string;
  feedforward: string;
}

// Server begrenst bijlage-inhoud op 12000 tekens; blijf daar ruim onder.
const MAX_CONTENT = 11000;

export function buildExplainFeedbackExcerpt(args: {
  conceptName: string;
  explanation: string;
  feedback: string;
  sections?: ExplainFeedbackSections | null;
  score?: { total: number; reason: string } | null;
  sources?: Array<{ title: string; documentId?: string }>;
  courseId?: string | null;
  labels: ExplainExcerptLabels;
}): ChatExcerptAttachment {
  const L = args.labels;
  const s = args.sections;
  const lines: string[] = [
    `**${L.heading}** · ${args.conceptName}`,
    '',
    `**${L.yourExplanation}:**`,
    `> ${args.explanation.trim().replace(/\n+/g, ' ')}`,
    '',
    `**${L.feedback}:**`,
    (s ? s.feedback : args.feedback).trim(),
  ];
  if (args.score) {
    lines.push('', `**${L.score}:** ${args.score.total}/100${args.score.reason ? ` — ${args.score.reason}` : ''}`);
  }
  if (s && s.related.length > 0) {
    lines.push('', `**${L.related}:**`, ...s.related.map((r) => `- ${r.name}: ${r.relation}`));
  }
  if (s && s.feedforward.length > 0) {
    lines.push('', `**${L.feedforward}:**`, ...s.feedforward.map((f) => `- ${f}`));
  }
  let content = lines.join('\n');
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1)}…`;
  return {
    type: 'chat_excerpt',
    content,
    sources: (args.sources || []).slice(0, 12).map((src, i) => ({
      index: i + 1,
      title: src.title,
      ...(src.documentId ? { documentId: src.documentId } : {}),
    })),
    meta: { module: 'explain', ...(args.courseId ? { courseId: args.courseId } : {}), capturedAt: new Date().toISOString() },
  };
}
