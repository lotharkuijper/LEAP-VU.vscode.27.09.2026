import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, CheckCircle2, ChevronRight, Search } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useLanguage } from '../../i18n';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import {
  fetchCourseFiles,
  fetchReadiness,
  type CourseFile,
  type CourseProject,
  type Readiness,
  type WebSource,
} from '../../services/course-files.service';
import { RAGDocumentStatusPanel } from '../RAGDocumentStatusPanel';
import { FilesStep } from './FilesStep';
import { PurposeReview } from './PurposeReview';
import { ReadinessStep, WarningList, type MaterialStep } from './ReadinessStep';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export const MATERIAL_STEPS: MaterialStep[] = ['files', 'processing', 'concepts', 'ready'];

/**
 * Werkruimte "Cursusmateriaal": één plek per cursus, begeleid in vier stappen.
 * De begrippenlijst (stap 3) blijft de bestaande, beproefde lijst uit
 * AdminPage; die rendert AdminPage direct onder deze component.
 */
export function CourseMaterialWorkspace({
  step,
  onStepChange,
  onOpenConcept,
  onGoToTab,
  onConceptsChanged,
  refreshKey = 0,
}: {
  step: MaterialStep;
  onStepChange: (s: MaterialStep) => void;
  onOpenConcept: (id: string) => void;
  onGoToTab: (tab: 'projects_admin' | 'quiz_sources') => void;
  onConceptsChanged?: () => void;
  refreshKey?: number;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const { activeCourseId, activeCourse } = useActiveCourse();
  const [files, setFiles] = useState<CourseFile[] | null>(null);
  const [projects, setProjects] = useState<CourseProject[]>([]);
  const [webSources, setWebSources] = useState<WebSource[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewDeferred, setReviewDeferred] = useState(false);
  const [findingNew, setFindingNew] = useState(false);
  const [findResult, setFindResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Nieuwe begrippen zoeken zonder de bestaande lijst (en eerdere goedkeuringen)
  // te vervangen: de server voegt alleen toe (replace:false) en meldt wat nieuw is.
  const findNewConcepts = async () => {
    if (!activeCourseId) return;
    setFindingNew(true);
    setFindResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/admin/extract-concepts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ courseId: activeCourseId, replace: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const names: string[] = (body.concepts || []).map((c: { name: string }) => c.name);
      setFindResult({
        kind: 'ok',
        text: names.length ? t('material.concepts.foundNew', { n: String(names.length), names: names.join(', ') }) : t('material.concepts.foundNone'),
      });
      onConceptsChanged?.();
    } catch (err) {
      setFindResult({ kind: 'error', text: t('material.concepts.findFailed', { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setFindingNew(false);
    }
  };

  const load = useCallback(async () => {
    if (!activeCourseId) return;
    setLoading(true);
    setError(null);
    try {
      const [f, r] = await Promise.all([fetchCourseFiles(activeCourseId), fetchReadiness(activeCourseId)]);
      setFiles(f.files);
      setProjects(f.projects);
      setWebSources(f.webSources || []);
      setReadiness(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeCourseId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  // Zolang er bestanden worden ingelezen: elke 8 s verversen zodat status en
  // aantallen vanzelf bijwerken.
  const busy = (files || []).some(f => f.processing_status === 'processing' || f.processing_status === 'pending');
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(id);
  }, [busy, load]);

  if (!activeCourseId) {
    return <p className="text-sm text-gray-600" data-testid="text-material-no-course">{t('material.noCourse')}</p>;
  }

  const warningsFor = (s: MaterialStep) => (readiness?.warnings || []).filter(w => w.step === s && w.severity !== 'info');
  const unconfirmed = (files || []).filter(f => !f.purposeConfirmed).length;

  return (
    <div className="space-y-6" data-testid="workspace-course-material">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{t('material.title')}</h2>
          <p className="text-sm text-gray-600 mt-1">{t('material.subtitle', { course: activeCourse?.name || '' })}</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50" data-testid="button-material-refresh">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t('material.refresh')}
        </button>
      </header>

      {/* Stappenbalk met status per stap */}
      <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('material.title')}>
        {MATERIAL_STEPS.map((s, i) => {
          const active = s === step;
          const issues = s === 'ready'
            ? (readiness?.warnings || []).filter(w => w.severity !== 'info').length
            : warningsFor(s).length;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onStepChange(s)}
              className={`text-left rounded-xl border px-4 py-3 transition-all ${active ? 'border-sky-400 bg-sky-50 ring-2 ring-sky-200' : 'border-gray-200 bg-white hover:border-gray-300'}`}
              aria-current={active ? 'step' : undefined}
              data-testid={`step-${s}`}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${active ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-700'}`}>{i + 1}</span>
                <span className="font-semibold text-gray-900 text-sm">{tk(`material.steps.${s}`)}</span>
              </div>
              <p className="text-xs text-gray-600 mt-1">{tk(`material.steps.${s}Hint`)}</p>
              {readiness && (
                <p className={`text-xs mt-1 font-medium ${issues ? 'text-amber-700' : 'text-emerald-700'}`} data-testid={`step-status-${s}`}>
                  {issues ? t('material.status.attention', { n: String(issues) }) : <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('material.status.ok')}</span>}
                </p>
              )}
            </button>
          );
        })}
      </nav>

      {error && <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{t('material.loadFailed', { error })}</p>}
      {!files && !error && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('material.loading')}</p>}

      {/* Eenmalige controle: bovenaan tot alles een doel heeft */}
      {files && unconfirmed > 0 && (
        reviewDeferred && step !== 'files' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-fuchsia-200 bg-fuchsia-50 px-4 py-2 text-sm text-fuchsia-900">
            {t('material.review.pending', { n: String(unconfirmed) })}
            <button type="button" onClick={() => { setReviewDeferred(false); onStepChange('files'); }} className="underline font-medium">{t('material.review.start')}</button>
          </div>
        ) : !reviewDeferred && (
          <PurposeReview
            key={files.filter(f => !f.purposeConfirmed).map(f => f.id).join(',')}
            courseId={activeCourseId}
            files={files}
            projects={projects}
            onDone={() => void load()}
            onLater={() => setReviewDeferred(true)}
          />
        )
      )}

      {files && step === 'files' && (
        <>
          <WarningList warnings={warningsFor('files').filter(w => w.code !== 'unconfirmedPurposes')} onGoTo={onStepChange} />
          <FilesStep courseId={activeCourseId} files={files} projects={projects} webSources={webSources} onChanged={() => void load()} onGoToProjects={() => onGoToTab('projects_admin')} />
        </>
      )}

      {step === 'processing' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">{t('material.processing.intro')}</p>
          <WarningList warnings={warningsFor('processing')} onGoTo={onStepChange} />
          <RAGDocumentStatusPanel />
        </div>
      )}

      {step === 'concepts' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">{t('material.concepts.intro')}</p>
          <WarningList warnings={warningsFor('concepts')} onGoTo={onStepChange} />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={findNewConcepts}
              disabled={findingNew}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-sky-300 text-sky-800 bg-white hover:bg-sky-50 disabled:opacity-50"
              data-testid="button-find-new-concepts"
            >
              {findingNew ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {findingNew ? t('material.concepts.findingNew') : t('material.concepts.findNew')}
            </button>
            {findResult && (
              <span className={`text-sm ${findResult.kind === 'ok' ? 'text-emerald-800' : 'text-red-700'}`} data-testid="text-find-new-result">{findResult.text}</span>
            )}
          </div>
        </div>
      )}

      {step === 'ready' && readiness && (
        <ReadinessStep courseId={activeCourseId} readiness={readiness} onGoTo={onStepChange} onOpenConcept={onOpenConcept} />
      )}

      {step !== 'ready' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onStepChange(MATERIAL_STEPS[MATERIAL_STEPS.indexOf(step) + 1])}
            className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:text-sky-900"
            data-testid="button-next-step"
          >
            {t('material.next', { step: tk(`material.steps.${MATERIAL_STEPS[MATERIAL_STEPS.indexOf(step) + 1]}`) })}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
