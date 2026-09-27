import { useMemo, useState } from 'react';
import { AlertTriangle, AlertCircle, Info, CheckCircle2, Loader2, Sparkles, X, Check } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import type { Readiness, ReadinessWarning } from '../../services/course-files.service';
import { retrieveQuizContext } from '../../services/quiz-context.service';
import { buildContextWithCap } from '../../services/rag.service';
import { generateMixedQuiz } from '../../services/quiz-mix.service';
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

export function WarningList({ warnings, onGoTo }: { warnings: ReadinessWarning[]; onGoTo: (s: MaterialStep) => void }) {
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
            <button type="button" onClick={() => onGoTo(w.step)} className="text-xs font-medium underline whitespace-nowrap">
              {t('material.ready.goTo', { step: tk(`material.steps.${w.step}`) })}
            </button>
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

  const concepts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return readiness.concepts.filter(c =>
      (!q || c.name.toLowerCase().includes(q)) && (!onlyProblems || (c.visible && !c.quizReady)));
  }, [readiness.concepts, filter, onlyProblems]);

  // "Probeer als student": exact dezelfde keten als de quiz (materiaal ophalen,
  // genereren, kwaliteitscontrole) voor één meerkeuzevraag over dit begrip.
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
      const ragContext = ctx.chunks.length ? buildContextWithCap(ctx.chunks).context : undefined;
      const result = await generateMixedQuiz({
        courseId, conceptIds: [id], topicNames: [name], difficulty: 'medium', questionType: 'mcq',
        numQuestions: 1, ragContext, ragStrictMode: quiz.rag_strict_mode !== false,
        mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
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

  const yesNo = (v: boolean) => v
    ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="w-3.5 h-3.5" />{t('material.ready.yes')}</span>
    : <span className="inline-flex items-center gap-1 text-red-700"><X className="w-3.5 h-3.5" />{t('material.ready.no')}</span>;

  return (
    <div className="space-y-6">
      <AdminHint variant="intro">{t('material.ready.intro')}</AdminHint>

      {readiness.warnings.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900 font-medium" data-testid="text-ready-all-good">
          <CheckCircle2 className="w-5 h-5" /> {t('material.ready.allGood')}
        </div>
      ) : (
        <WarningList warnings={readiness.warnings} onGoTo={onGoTo} />
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

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('material.ready.filter')}
            className="chic-input text-sm px-3 py-1.5 w-64"
            data-testid="input-readiness-filter"
          />
          <label className="text-sm text-gray-700 inline-flex items-center gap-2">
            <input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} data-testid="checkbox-only-problems" />
            {t('material.ready.onlyProblems')}
          </label>
        </div>
        {readiness.concepts.length === 0 ? (
          <p className="text-sm text-gray-500">{t('material.ready.noConcepts')}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">{t('material.ready.col.concept')}</th>
                  <th className="px-3 py-2">{t('material.ready.col.evidence')}</th>
                  <th className="px-3 py-2">{t('material.ready.col.quiz')}</th>
                  <th className="px-3 py-2">{t('material.ready.col.itembank')}</th>
                  <th className="px-3 py-2">{t('material.ready.col.visible')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {concepts.map(c => (
                  <tr key={c.id} className={`border-t border-gray-100 ${!c.visible ? 'text-gray-400' : ''}`} data-testid={`row-readiness-${c.id}`}>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => onOpenConcept(c.id)} className="font-medium text-left text-sky-800 hover:underline" data-testid={`button-open-concept-${c.id}`}>
                        {c.name}
                      </button>
                    </td>
                    <td className="px-3 py-2">{c.evidenceDocuments}</td>
                    <td className="px-3 py-2">{yesNo(c.quizReady)}</td>
                    <td className="px-3 py-2">{c.itembankSections || '—'}</td>
                    <td className="px-3 py-2">{c.visible ? yesNo(true) : <span>{t('material.ready.hidden')}</span>}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => tryAsStudent(c.id, c.name)}
                        disabled={!!trying}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-50"
                        data-testid={`button-try-${c.id}`}
                      >
                        {trying === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {t('material.ready.try')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
