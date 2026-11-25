import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, Search, SlidersHorizontal, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { useTask } from '../../lib/backgroundTasks';
import { CONCEPT_TASK_KIND, startConceptExtractionTask, type ExtractionOptions } from '../../lib/conceptExtractionJob';
import { defaultSearchMode, describeSearchResult, searchBody, type ResultLine, type SearchMode, type SearchResponse } from '../../lib/conceptSearch';
import { fetchConceptSearchScope, resetRemovedConcepts, type SearchScope } from '../../services/course-files.service';
import { ExtractionProgressText } from '../ExtractionProgressText';
import { HelpTip } from '../help/HelpTip';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/**
 * Eén plek om begrippen te laten zoeken, met drie duidelijke keuzes:
 * alleen in nieuwe of gekozen bestanden, in alle leerstof aanvullen, of de
 * lijst opnieuw samenstellen. Bij elke keuze staat wat er met je bestaande
 * begrippen gebeurt. Zie src/lib/conceptSearch.ts en
 * docs/decisions/cursusmateriaal-en-rag.md.
 */
export function ConceptSearchPanel({
  courseId,
  conceptCount,
  language,
  onLanguageChange,
  bounds,
  refreshKey = 0,
  onDone,
}: {
  courseId: string;
  /** Aantal begrippen dat de cursus nu heeft (0 = eerste keer zoeken). */
  conceptCount: number;
  language: ExtractionOptions['language'];
  onLanguageChange: (l: ExtractionOptions['language']) => void;
  /** Minimum/maximum aantal begrippen (AdminPage), onder "Meer opties". */
  bounds?: ReactNode;
  /** Verandert als de leerstof is bijgewerkt: dan opnieuw ophalen wat nieuw is. */
  refreshKey?: number;
  onDone?: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const { activeCourse } = useActiveCourse();
  const task = useTask(CONCEPT_TASK_KIND, courseId);
  const taskRunning = task?.status === 'running';

  const [scope, setScope] = useState<SearchScope | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; lines: ResultLine[]; error?: string } | null>(null);
  // Keuze en vinkjes alleen opnieuw zetten als de set nieuwe bestanden verandert,
  // niet bij elke verversing (bv. na het aan/uit zetten van een begrip).
  const freshKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetchConceptSearchScope(courseId);
      setScope(s);
      setScopeError(null);
      const fresh = s.documents.filter(d => d.isNew).map(d => d.id);
      const key = fresh.join('|');
      if (freshKey.current !== key) {
        freshKey.current = key;
        setChosen(new Set(fresh));
        setMode(defaultSearchMode(fresh.length));
      }
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : String(err));
    }
  }, [courseId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const newDocs = useMemo(() => (scope?.documents || []).filter(d => d.isNew), [scope]);
  const listedDocs = showAllFiles ? scope?.documents || [] : newDocs;
  const firstTime = conceptCount === 0;
  const effectiveMode: SearchMode = firstTime ? 'all' : mode;
  const busy = running || taskRunning;
  const canStart = !busy && (effectiveMode !== 'files' || chosen.size > 0) && (scope?.documents.length || 0) > 0;

  const toggleDoc = (id: string) => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const start = async () => {
    if (effectiveMode === 'rebuild' && !confirmRebuild) { setConfirmRebuild(true); return; }
    setConfirmRebuild(false);
    setRunning(true);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const body = await startConceptExtractionTask({
        courseId,
        body: searchBody(courseId, effectiveMode, language, [...chosen]),
        token: session?.access_token || '',
        title: t('tasks.concepts.title', { course: activeCourse?.name || '' }),
        resultLink: '/admin?tab=material&step=concepts',
      }).promise as SearchResponse;
      setResult({ ok: true, lines: describeSearchResult(body, effectiveMode) });
      onDone?.();
      void load();
    } catch (err) {
      setResult({ ok: false, lines: [], error: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  const resetRemoved = async () => {
    try {
      await resetRemovedConcepts(courseId);
      void load();
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : String(err));
    }
  };

  const option = (value: SearchMode, title: string, desc: ReactNode, extra?: ReactNode) => (
    <label
      className={`block cursor-pointer rounded-xl border px-4 py-3 transition-colors ${mode === value ? 'border-sky-400 bg-sky-50 ring-1 ring-sky-200' : 'border-gray-200 bg-white hover:border-gray-300'}`}
      data-testid={`option-search-${value}`}
    >
      <span className="flex items-start gap-3">
        <input
          type="radio"
          name="concept-search-mode"
          value={value}
          checked={mode === value}
          onChange={() => { setMode(value); setConfirmRebuild(false); }}
          className="mt-1"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-900">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-gray-700">{desc}</span>
          {mode === value && extra}
        </span>
      </span>
    </label>
  );

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4" data-testid="panel-concept-search">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-gray-900">
          <Search className="h-5 w-5 text-sky-600" aria-hidden />
          {firstTime ? t('material.search.titleFirst') : t('material.search.title')}
          <HelpTip id="material.findNewConcepts" />
        </h3>
        <p className="mt-0.5 text-sm text-gray-700">
          {firstTime ? t('material.search.introFirst') : t('material.search.intro')}
        </p>
      </div>

      {scopeError && <p className="text-sm text-red-700" data-testid="text-search-scope-error">{t('material.search.scopeFailed', { error: scopeError })}</p>}
      {scope && scope.documents.length === 0 && (
        <p className="text-sm text-amber-800" data-testid="text-search-no-material">{t('material.search.noMaterial')}</p>
      )}

      {!firstTime && scope && scope.documents.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('material.search.legend')}</legend>
          {option(
            'files',
            t('material.search.files.title'),
            newDocs.length > 0
              ? tk('material.search.files.descNew', { n: String(newDocs.length) })
              : t('material.search.files.descNone'),
            <div className="mt-2 space-y-1">
              {listedDocs.length > 0 && (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 bg-white px-3 py-2" data-testid="list-search-files">
                  {listedDocs.map(d => (
                    <li key={d.id}>
                      <label className="flex min-w-0 items-center gap-2 py-0.5 text-sm">
                        <input type="checkbox" checked={chosen.has(d.id)} onChange={() => toggleDoc(d.id)} data-testid={`checkbox-search-doc-${d.id}`} />
                        <span className="min-w-0 truncate text-gray-800">{d.title}</span>
                        {d.isNew && <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">{t('material.search.files.newBadge')}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" onClick={() => setShowAllFiles(v => !v)} className="text-xs font-medium text-sky-700 hover:underline" data-testid="button-search-show-all-files">
                {showAllFiles ? t('material.search.files.onlyNew') : tk('material.search.files.chooseOther', { n: String(scope.documents.length) })}
              </button>
            </div>,
          )}
          {option('all', t('material.search.all.title'), t('material.search.all.desc'))}
          {option('rebuild', t('material.search.rebuild.title'), t('material.search.rebuild.desc'))}
        </fieldset>
      )}

      {scope && scope.removedCount > 0 && (
        <p className="text-xs text-gray-600" data-testid="text-search-removed">
          {tk('material.search.removedNote', { n: String(scope.removedCount) })}{' '}
          <button type="button" onClick={resetRemoved} className="font-medium text-sky-700 hover:underline" data-testid="button-search-reset-removed">
            {t('material.search.removedReset')}
          </button>
        </p>
      )}

      <details className="rounded-lg border border-gray-200" data-testid="panel-search-options">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700">
          <SlidersHorizontal className="h-4 w-4 text-gray-500" aria-hidden />
          {t('material.extractOptions.title')}
          {language !== 'auto' && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">{t('material.extractOptions.active')}</span>}
        </summary>
        <div className="space-y-3 border-t border-gray-100 px-3 py-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">{t('material.extractOptions.language')}</span>
            <select
              value={language}
              onChange={e => onLanguageChange(e.target.value as ExtractionOptions['language'])}
              className="w-full max-w-xs rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              data-testid="select-extraction-language"
            >
              <option value="auto">{t('material.extractOptions.langAuto')}</option>
              <option value="nl">{t('material.extractOptions.langNl')}</option>
              <option value="en">{t('material.extractOptions.langEn')}</option>
            </select>
          </label>
          {bounds}
        </div>
      </details>

      {confirmRebuild && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="confirm-rebuild">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t('material.search.rebuild.confirm')}</span>
          <button type="button" onClick={start} className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700" data-testid="button-confirm-rebuild">{t('material.search.rebuild.confirmYes')}</button>
          <button type="button" onClick={() => setConfirmRebuild(false)} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-gray-700">{t('common.cancelAction')}</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={!canStart || confirmRebuild}
          className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          data-testid="button-start-concept-search"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {busy ? t('material.search.running') : effectiveMode === 'rebuild' ? t('material.search.rebuild.button') : t('material.search.button')}
        </button>
        {busy && <ExtractionProgressText progress={task?.progress} />}
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}
          data-testid="text-concept-search-result"
        >
          {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <div className="min-w-0 space-y-1">
            {result.ok
              ? result.lines.map((l, i) => <p key={i}>{tk(l.key, l.vars)}</p>)
              : <p>{t('material.search.failed', { error: result.error || '' })}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
