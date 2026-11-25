import { useMemo, useState } from 'react';
import { AlertTriangle, AlertCircle, Info, CheckCircle2, Loader2, Sparkles, Pencil } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import type { Readiness, ReadinessWarning } from '../../services/course-files.service';
import { retrieveQuizContext } from '../../services/quiz-context.service';
import { startQuizSession } from '../../services/quiz-session.service';
import type { MCQQuestion } from '../../services/llm.service';
import { PURPOSE_ORDER, PurposeChip } from './purposeUi';
import { AdminHint } from '../help/AdminHint';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
export type MaterialStep = 'files' | 'processing' | 'concepts' | 'ready';

const SEVERITY_STYLE: Record<ReadinessWarning['severity'], { box: string; icon: typeof AlertCircle }> = {
  error: { box: 'bg-red-50 border-red-200 text-red-900', icon: AlertCircle },
  warning: { box: 'bg-amber-50 border-amber-200 text-amber-900', icon: AlertTriangle },
  info: { box: 'bg-sky-50 border-sky-200 text-sky-900', icon: Info },
};

/** Waarschuwingen met een link naar de stap waar je het oplost (niet als je daar al bent). */
export function WarningList({ warnings, onGoTo, currentStep }: { warnings: ReadinessWarning[]; onGoTo: (s: MaterialStep) => void; currentStep?: MaterialStep }) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-2" data-testid="list-readiness-warnings">
      {warnings.map(w => {
        const s = SEVERITY_STYLE[w.severity];
        const Icon = s.icon;
        return (
          <li key={w.code} className={`rounded-xl border px-4 py-3 flex flex-wrap items-start gap-3 ${s.box}`} data-testid={`warning-${w.code}`}>
            <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-[14rem]">
              <p className="font-semibold text-sm">{tk(`material.warning.${w.code}.title`, { n: String(w.count) })}</p>
              <p className="text-xs mt-0.5">{tk(`material.warning.${w.code}.desc`)}</p>
              {w.items.length > 0 && w.items[0] !== '—' && (
                <p className="text-xs mt-1 opacity-80">{w.items.join(' · ')}{w.count > w.items.length ? ' …' : ''}</p>
              )}
            </div>
            {w.step !== currentStep && (
              <button type="button" onClick={() => onGoTo(w.step)} className="text-xs font-medium underline whitespace-nowrap" data-testid={`button-goto-${w.code}`}>
                {t('material.ready.goTo', { step: tk(`material.steps.${w.step}`) })}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface TryResult { name: string; question?: MCQQuestion; error?: string }

export function ReadinessStep({
  courseId,
  readiness,
  onGoTo,
  onOpenConcept,
}: {
  courseId: string;
  readiness: Readiness;
  onGoTo: (s: MaterialStep) => void;
  onOpenConcept: (id: string) => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [filter, setFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [trying, setTrying] = useState<string | null>(null);
  const [tryResult, setTryResult] = useState<TryResult | null>(null);

  const [showAll, setShowAll] = useState(false);
  // Standaard alleen wat studenten krijgen; verborgen en nog te beoordelen begrippen op verzoek.
  const notShown = readiness.concepts.filter(c => !c.visible).length;
  const concepts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return readiness.concepts.filter(c =>
      (showAll || c.visible)
      && (!q || c.name.toLowerCase().includes(q) || (c.definition || '').toLowerCase().includes(q))
      && (!onlyProblems || (c.visible && !c.quizReady)));
  }, [readiness.concepts, filter, onlyProblems, showAll]);

  // "Probeer als student": exact dezelfde keten als de quiz (materiaal ophalen,
  // genereren en controleren op de server) voor één meerkeuzevraag over dit
  // begrip, alleen uit het cursusmateriaal; er wordt niets bewaard.
  const tryAsStudent = async (id: string, name: string) => {
    setTrying(id);
    setTryResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const sres = await fetch(`/api/rag-settings?courseId=${courseId}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const settings = sres.ok ? await sres.json() : null;
      const quiz = settings?.quiz || { similarity_threshold: 0.65, match_count: 5, rag_strict_mode: true };
      const { data } = await supabase.from('concepts').select('definition, key_points').eq('id', id).maybeSingle();
      const c = data as unknown as { definition: string | null; key_points: string[] | null } | null;
      const ctx = await retrieveQuizContext({
        topics: [{ id, name, definition: c?.definition, keyPoints: c?.key_points }],
        courseId,
        role: 'docent',
        threshold: quiz.similarity_threshold,
        matchCount: quiz.match_count,
        expansionEnabled: !!quiz.query_expansion_enabled,
      });
      const result = await startQuizSession({
        courseId, conceptIds: [id], difficulty: 'medium', questionType: 'mcq', numQuestions: 1,
        chunkIds: ctx.chunks.map(c => c.id).filter(Boolean), tryout: true,
      });
      if (result.status === 'no_course_material') setTryResult({ name, error: t('material.ready.tryNoMaterial') });
      else if (!result.questions.length) setTryResult({ name, error: result.verification.lastError || t('quiz.verificationShortfall', { kept: '0', requested: '1' }) });
      else setTryResult({ name, question: result.questions[0] as MCQQuestion });
    } catch (err) {
      setTryResult({ name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTrying(null);
    }
  };

  return (
    <div className="space-y-6">
      <AdminHint variant="intro">{t('material.ready.intro')}</AdminHint>

      {readiness.warnings.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900 font-medium" data-testid="text-ready-all-good">
          <CheckCircle2 className="w-5 h-5" /> {t('material.ready.allGood')}
        </div>
      ) : (
        <WarningList warnings={readiness.warnings} onGoTo={onGoTo} currentStep="ready" />
      )}

      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{t('material.ready.counts')}</h3>
        <div className="flex flex-wrap gap-2">
          {PURPOSE_ORDER.map(p => (
            <span key={p} className="inline-flex items-center gap-1">
              <PurposeChip purpose={p} label={`${tk(`filePurpose.${p}.label`)}: ${readiness.counts[p] || 0}`} />
            </span>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{t('material.ready.checkTitle')}</h3>
          <p className="text-sm text-gray-700">{t('material.ready.checkIntro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('material.ready.filter')}
            aria-label={t('material.ready.filter')}
            className="chic-input text-sm px-3 py-1.5 w-64 max-w-full"
            data-testid="input-readiness-filter"
          />
          <label className="text-sm text-gray-700 inline-flex items-center gap-2">
            <input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} data-testid="checkbox-only-problems" />
            {t('material.ready.onlyProblems')}
          </label>
          {notShown > 0 && (
            <label className="text-sm text-gray-700 inline-flex items-center gap-2">
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} data-testid="checkbox-show-hidden" />
              {tk('material.ready.showNotShown', { n: String(notShown) })}
            </label>
          )}
        </div>
        {readiness.concepts.length === 0 ? (
          <p className="text-sm text-gray-500">{t('material.ready.noConcepts')}</p>
        ) : concepts.length === 0 ? (
          <p className="text-sm text-gray-500">{t('material.ready.noMatches')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white" data-testid="list-readiness-concepts">
            {concepts.map(c => (
              <li key={c.id} className="px-4 py-3" data-testid={`row-readiness-${c.id}`}>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <button type="button" onClick={() => onOpenConcept(c.id)} className="font-semibold text-left text-gray-900 hover:text-sky-800 hover:underline" data-testid={`button-open-concept-${c.id}`}>
                    {c.name}
                  </button>
                  {c.review && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{t('material.ready.badgeReview')}</span>}
                  {!c.visible && !c.review && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">{t('material.ready.hidden')}</span>}
                  {c.visible && !c.quizReady && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-800">{t('material.ready.badgeNoQuiz')}</span>}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-gray-800" data-testid={`text-readiness-definition-${c.id}`}>
                  {c.definition || <span className="italic text-gray-600">{t('material.ready.noDefinition')}</span>}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
                  <span>{c.evidenceDocuments === 1 ? t('material.ready.sourcesOne') : tk('material.ready.sources', { n: String(c.evidenceDocuments) })}</span>
                  {c.itembankSections > 0 && <span>{tk('material.ready.itembankN', { n: String(c.itembankSections) })}</span>}
                  <button type="button" onClick={() => onOpenConcept(c.id)} className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline" data-testid={`button-check-${c.id}`}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden />{t('material.ready.checkAction')}
                  </button>
                  <button
                    type="button"
                    onClick={() => tryAsStudent(c.id, c.name)}
                    disabled={!!trying}
                    className="inline-flex items-center gap-1 font-medium text-gray-700 hover:underline disabled:opacity-50"
                    data-testid={`button-try-${c.id}`}
                  >
                    {trying === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden />}
                    {t('material.ready.try')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(trying || tryResult) && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="dialog-try-as-student">
          <div className="chic-card max-w-2xl w-full p-6 space-y-4">
            {trying && !tryResult ? (
              <p className="text-sm text-gray-700 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('material.ready.trying')}</p>
            ) : tryResult && (
              <>
                <h3 className="text-lg font-semibold text-gray-900">{t('material.ready.tryTitle', { name: tryResult.name })}</h3>
                {tryResult.error ? (
                  <p className="text-sm text-red-800 bg-red-50 rounded-lg px-3 py-2">{t('material.ready.tryFailed', { reason: tryResult.error })}</p>
                ) : tryResult.question && (
                  <div className="space-y-3 text-sm">
                    <p className="font-medium text-gray-900">{tryResult.question.question}</p>
                    <ol className="space-y-1">
                      {tryResult.question.options.map((o, i) => (
                        <li key={i} className={`rounded-lg px-3 py-1.5 border ${i === tryResult.question!.correctAnswer ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
                          <span className="font-semibold mr-2">{String.fromCharCode(65 + i)}.</span>{o}
                        </li>
                      ))}
                    </ol>
                    <p className="text-gray-700"><span className="font-semibold">{t('material.ready.tryAnswer')}:</span> {tryResult.question.explanation}</p>
                  </div>
                )}
                <div className="flex justify-end">
                  <button type="button" onClick={() => setTryResult(null)} className="px-4 py-2 rounded-xl text-sm bg-gray-100 hover:bg-gray-200" data-testid="button-close-try">
                    {t('common.close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
