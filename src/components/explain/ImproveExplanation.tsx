import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookText, CheckCircle, Coffee, Loader2, RefreshCw, Send, Wand2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useCourseFeatures } from '../../hooks/useCourseFeatures';
import { MarkdownMessage } from '../MarkdownMessage';
import type { CitationSource } from '../CitationText';
import { openRagDocument } from '../../services/rag.service';
import { stashStudiecafeHandoff } from '../../lib/studiecafeHandoff';
import { FormulaButton } from '../../components/formula/FormulaButton';
import {
  createImproveExercise, evaluateImproveAnswer, saveImproveReflection,
  type ImproveExercise, type ImproveFeedback, type ImproveReveal,
} from '../../services/improveExplanation.service';

// "Verbeter deze uitleg" (onderdeel van Ik leg uit, server/flawedExplanations.js).
// De uitleg wordt ter plekke gemaakt en bevat één of meer fouten; de student weet
// niet hoeveel. Na het beoordelen ziet de student de fouten, de juiste uitleg en
// de bronnen, en kan hij alles ter discussie stellen in het Studiecafé.

interface Props {
  concept: { id: string; name: string };
  displayName: string;
  courseId: string | null;
}

/** Pure: Studiecafé-bijlage ("Klopt dit wel?") van een afgeronde oefening. */
export function buildImproveExcerpt(args: {
  conceptName: string;
  flawed: string;
  answer: string;
  reveal: ImproveReveal;
  courseId: string | null;
  labels: { heading: string; exercise: string; yourAnswer: string; errorsByAi: string; correct: string };
}) {
  const L = args.labels;
  const lines = [
    `**${L.heading}** · ${args.conceptName}`,
    '',
    `**${L.exercise}:**`,
    `> ${args.flawed.replace(/\n+/g, ' ')}`,
    '',
    `**${L.yourAnswer}:** ${args.answer.trim()}`,
    '',
    `**${L.errorsByAi}:**`,
    ...args.reveal.errors.map((e, i) => `${i + 1}. "${e.sentence}" — ${e.why} ${e.correct ? `(${e.correct})` : ''} [${e.source}]`),
    '',
    `**${L.correct}:** ${args.reveal.correct}`,
  ];
  let content = lines.join('\n');
  if (content.length > 11000) content = `${content.slice(0, 10999)}…`;
  return {
    type: 'chat_excerpt' as const,
    content,
    sources: args.reveal.sources.slice(0, 12).map(s => ({ index: s.index, title: s.title, ...(s.documentId ? { documentId: s.documentId } : {}) })),
    meta: { module: 'explain', ...(args.courseId ? { courseId: args.courseId } : {}), capturedAt: new Date().toISOString() },
  };
}

export function ImproveExplanation({ concept, displayName, courseId }: Props) {
  const { t } = useLanguage();
  const features = useCourseFeatures();
  const [exercise, setExercise] = useState<ImproveExercise | null>(null);
  const [creating, setCreating] = useState(false);
  const [answer, setAnswer] = useState('');
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<{ feedback: ImproveFeedback; reveal: ImproveReveal } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const [reflected, setReflected] = useState(false);

  // Ander begrip: begin opnieuw.
  useEffect(() => {
    setExercise(null); setAnswer(''); setResult(null); setError(null); setReflected(false);
  }, [concept.id]);

  const create = async () => {
    setCreating(true); setError(null); setResult(null); setAnswer(''); setReflected(false); setExercise(null);
    try {
      setExercise(await createImproveExercise(concept.id, courseId));
    } catch (e) {
      setError((e as Error).message);
    }
    setCreating(false);
  };

  const evaluate = async () => {
    if (!exercise || !answer.trim()) return;
    setEvaluating(true); setError(null);
    try {
      setResult(await evaluateImproveAnswer(exercise.token, answer));
    } catch (e) {
      setError((e as Error).message);
    }
    setEvaluating(false);
  };

  const reflect = async () => {
    if (!exercise || !result) return;
    setReflecting(true); setError(null);
    try {
      await saveImproveReflection(exercise.token, answer, result.feedback);
      setReflected(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setReflecting(false);
  };

  const citationSources: CitationSource[] = (result?.reveal.sources || []).map(s => ({ index: s.index, title: s.title, documentId: s.documentId || undefined }));
  const openSource = (s: CitationSource) => { if (s.documentId) openRagDocument(s.documentId).catch(() => { /* stil */ }); };

  const checkLLM = () => {
    if (!exercise || !result) return;
    stashStudiecafeHandoff({
      v: 1,
      courseId,
      category: 'check-llm',
      attachment: buildImproveExcerpt({
        conceptName: displayName,
        flawed: exercise.text,
        answer,
        reveal: result.reveal,
        courseId,
        labels: {
          heading: t('explain.improve.check.heading'),
          exercise: t('explain.improve.check.exercise'),
          yourAnswer: t('explain.improve.check.yourAnswer'),
          errorsByAi: t('explain.improve.check.errorsByAi'),
          correct: t('explain.improve.correctTitle'),
        },
      }),
      mode: 'thread',
    }, { crossTab: true });
  };

  const fb = result?.feedback;

  return (
    <div className="space-y-6" data-testid="panel-improve">
      <div className="chic-card p-6 space-y-4">
        <p className="text-sm text-gray-700">{t('explain.improve.intro', { name: displayName })}</p>

        {!exercise && (
          <button
            onClick={create}
            disabled={creating}
            className="w-full px-6 py-3 bg-gradient-to-r from-amber-500 to-amber-600 text-white font-semibold rounded-xl hover:from-amber-600 hover:to-amber-700 transition-all shadow-lg disabled:opacity-60 flex items-center justify-center gap-2"
            data-testid="button-improve-create"
          >
            {creating ? <><Loader2 className="w-5 h-5 animate-spin" />{t('explain.improve.creating')}</> : <><Wand2 className="w-5 h-5" />{t('explain.improve.create')}</>}
          </button>
        )}

        {exercise && (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="note" data-testid="text-improve-disclaimer">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{t('explain.improve.disclaimer')}</span>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4" data-testid="text-improve-exercise">
              <MarkdownMessage content={exercise.text} />
            </div>
            <div>
              <div className="mb-2 flex items-end justify-between gap-2">
                <label htmlFor="improve-answer" className="block text-sm font-semibold text-gray-700">{t('explain.improve.answerLabel')}</label>
                {!result && <FormulaButton targetRef={answerRef} value={answer} onChange={setAnswer} testId="button-formula-improve" />}
              </div>
              <textarea
                ref={answerRef}
                id="improve-answer"
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                disabled={!!result}
                rows={7}
                placeholder={t('explain.improve.answerPlaceholder')}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none resize-none disabled:bg-gray-50"
                data-testid="textarea-improve-answer"
              />
            </div>
            {!result && (
              <button
                onClick={evaluate}
                disabled={evaluating || !answer.trim()}
                className="w-full px-6 py-3 bg-gradient-to-r from-amber-500 to-amber-600 text-white font-semibold rounded-xl hover:from-amber-600 hover:to-amber-700 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="button-improve-evaluate"
              >
                {evaluating ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Send className="w-5 h-5" />{t('explain.improve.submit')}</>}
              </button>
            )}
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="text-improve-error">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {result && fb && (
        <div className="chic-card p-6 space-y-5" data-testid="panel-improve-feedback">
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle className="w-5 h-5 text-accent-600" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-gray-900">{t('explain.improve.feedbackTitle')}</h3>
            {fb.found != null && (
              <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700 ring-1 ring-brand-200" data-testid="text-improve-found">
                {t('explain.improve.foundCount', { found: String(fb.found), total: String(fb.total) })}
              </span>
            )}
          </div>
          {fb.foundDetail && <section><MarkdownMessage content={fb.foundDetail} sources={citationSources} onSourceOpen={openSource} /></section>}
          {fb.reasoning && (
            <section>
              <h4 className="text-sm font-semibold text-gray-800 mb-1">{t('explain.improve.reasoningTitle')}</h4>
              <MarkdownMessage content={fb.reasoning} sources={citationSources} onSourceOpen={openSource} />
            </section>
          )}
          {fb.wronglyFlagged && (
            <section>
              <h4 className="text-sm font-semibold text-gray-800 mb-1">{t('explain.improve.wronglyFlaggedTitle')}</h4>
              <MarkdownMessage content={fb.wronglyFlagged} sources={citationSources} onSourceOpen={openSource} />
            </section>
          )}
          {fb.nextStep && (
            <section>
              <h4 className="text-sm font-semibold text-gray-800 mb-1">{t('explain.improve.nextStepTitle')}</h4>
              <MarkdownMessage content={fb.nextStep} sources={citationSources} onSourceOpen={openSource} />
            </section>
          )}

          <section className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3" data-testid="panel-improve-reveal">
            <h4 className="text-sm font-semibold text-gray-800">{t('explain.improve.errorsTitle', { total: String(result.reveal.errors.length) })}</h4>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-800">
              {result.reveal.errors.map((e, i) => (
                <li key={i}>
                  <span className="italic">“{e.sentence}”</span>
                  <div className="text-gray-700"><MarkdownMessage content={`${e.why}${e.correct ? `\n\n**${t('explain.improve.correctIs')}** ${e.correct}` : ''} [${e.source}]`} sources={citationSources} onSourceOpen={openSource} /></div>
                </li>
              ))}
            </ol>
            <div>
              <h4 className="text-sm font-semibold text-gray-800 mb-1">{t('explain.improve.correctTitle')}</h4>
              <MarkdownMessage content={result.reveal.correct} />
            </div>
            {result.reveal.sources.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-800 mb-1">{t('explain.improve.sourcesTitle')}</h4>
                <ul className="space-y-1 text-xs text-gray-600">
                  {result.reveal.sources.map(s => (
                    <li key={s.index}>
                      [{s.index}]{' '}
                      {s.documentId ? (
                        <button type="button" onClick={() => openRagDocument(s.documentId!).catch(() => {})} className="text-brand-700 underline hover:text-brand-800">{s.title || t('explain.improve.source')}</button>
                      ) : (s.title || t('explain.improve.source'))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={create}
              disabled={creating}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              data-testid="button-improve-new"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {creating ? t('explain.improve.creating') : t('explain.improve.newExercise')}
            </button>
            {features.visible('journal') && (
              <button
                onClick={reflect}
                disabled={reflecting || reflected}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-60"
                data-testid="button-improve-reflect"
              >
                {reflecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookText className="w-4 h-4" />}
                {reflected ? t('explain.improve.reflected') : t('explain.improve.reflect')}
              </button>
            )}
            {features.visible('studiecafe') && (
              <a
                href="/studiecafe"
                target="_blank"
                rel="noopener"
                onClick={checkLLM}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
                data-testid="button-improve-check-llm"
              >
                <Coffee className="w-4 h-4" />
                {t('quiz.checkLLM.label')}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
