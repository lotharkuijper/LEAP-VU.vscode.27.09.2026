import { useCallback, useEffect, useState } from 'react';
import { FileText, GitMerge, Loader2, Search, X, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../i18n';
import { HelpTip } from './help/HelpTip';
import { AdminHint } from './help/AdminHint';

interface Coverage { documentId: string; title: string; concepts: number }
type ConceptClass = 'course' | 'module' | 'example';
interface MergeSuggestion {
  /** crossClass = moduleconcept(en) die al als cursusconcept bestaan. */
  kind?: 'crossClass' | 'same';
  keep: { id: string; name: string; reviewStatus: string | null; cls?: ConceptClass };
  others: Array<{ id: string; name: string; reviewStatus: string | null; cls?: ConceptClass }>;
}

/**
 * Kwaliteit van de begrippenlijst: per leerstofdocument hoeveel begrippen er
 * zijn (een document met 0 begrippen valt meteen op), en voorgestelde
 * samenvoegingen voor synoniemen/afkortingen/vertalingen. Zekere
 * spellingvarianten voegt LEAP zelf samen; dit zijn de twijfelgevallen.
 */
export function ConceptQualityPanel({ courseId, token, onChanged, refreshKey = 0 }: {
  courseId: string;
  token: string;
  onChanged: () => void;
  /** Verhoog om het overzicht opnieuw te laden (bv. na hergenereren). */
  refreshKey?: number;
}) {
  const { t } = useLanguage();
  const [coverage, setCoverage] = useState<Coverage[] | null>(null);
  const [suggestions, setSuggestions] = useState<MergeSuggestion[] | null>(null);
  const [autoMerged, setAutoMerged] = useState(0);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const loadCoverage = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/concepts/coverage?courseId=${encodeURIComponent(courseId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (r.ok) setCoverage(d.documents || []);
    } catch { /* overzicht is aanvullend */ }
  }, [courseId, token]);

  useEffect(() => { void loadCoverage(); }, [loadCoverage, refreshKey]);

  const findSuggestions = async () => {
    setSearching(true); setError(null); setAutoMerged(0);
    try {
      const r = await fetch(`/api/admin/concepts/merge-suggestions?courseId=${encodeURIComponent(courseId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      // Zekere dubbelingen zijn dan al samengevoegd, ook als de voorstellen daarna mislukken.
      const n = Number(d.autoMerged) || 0;
      if (n > 0) { setAutoMerged(n); onChanged(); void loadCoverage(); }
      if (!r.ok) throw new Error(d.error || t('admin.conceptQuality.err.suggest'));
      setSuggestions(d.suggestions || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSearching(false); }
  };

  // Welke naam blijft, per voorstel (sleutel: s.keep.id). Standaard LEAP's
  // keuze (het cursusconcept); de docent kan elke naam uit de groep kiezen.
  // Het bewijs uit alle documenten gaat mee, dus een begrip dat ook als
  // cursusconcept bestond, komt hoe dan ook onder Cursusconcepten.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const membersOf = (s: MergeSuggestion) => [s.keep, ...s.others];
  const chosenOf = (s: MergeSuggestion) => membersOf(s).find(m => m.id === chosen[s.keep.id]) || s.keep;
  const classLabel: Record<ConceptClass, string> = {
    course: t('admin.conceptQuality.cls.course'),
    module: t('admin.conceptQuality.cls.module'),
    example: t('admin.conceptQuality.cls.example'),
  };

  const merge = async (s: MergeSuggestion) => {
    const keep = chosenOf(s);
    setBusyId(s.keep.id); setError(null);
    try {
      const r = await fetch('/api/admin/concepts/merge', { method: 'POST', headers, body: JSON.stringify({ courseId, keepId: keep.id, dupIds: membersOf(s).filter(m => m.id !== keep.id).map(m => m.id) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t('admin.conceptQuality.err.merge'));
      setSuggestions(prev => (prev || []).filter(x => x !== s));
      onChanged(); void loadCoverage();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };

  const dismiss = async (s: MergeSuggestion) => {
    setSuggestions(prev => (prev || []).filter(x => x !== s));
    await fetch('/api/admin/concepts/merge-dismiss', { method: 'POST', headers, body: JSON.stringify({ courseId, ids: [s.keep.id, ...s.others.map(o => o.id)] }) }).catch(() => {});
  };

  const empty = (coverage || []).filter(c => c.concepts === 0);

  return (
    <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]" data-testid="panel-concept-quality">
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <FileText className="h-4 w-4 text-gray-500" />{t('admin.conceptQuality.coverageTitle')}<HelpTip id="concepts.coverage" />
        </h3>
        {coverage === null ? (
          <p className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('common.loading')}</p>
        ) : coverage.length === 0 ? (
          <p className="text-xs text-gray-500">{t('admin.conceptQuality.noDocuments')}</p>
        ) : (
          <>
            {empty.length > 0 && (
              <AdminHint variant="warning" className="mb-2">
                {t('admin.conceptQuality.emptyWarning', { n: String(empty.length) })}
              </AdminHint>
            )}
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs" data-testid="list-concept-coverage">
              {coverage.map(c => (
                <li key={c.documentId} className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 truncate ${c.concepts === 0 ? 'font-medium text-amber-700' : 'text-gray-700'}`} title={c.title}>{c.title}</span>
                  <span className={`flex-shrink-0 rounded-full px-2 py-0.5 font-semibold tabular-nums ${c.concepts === 0 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`} data-testid={`coverage-count-${c.documentId}`}>
                    {c.concepts}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <GitMerge className="h-4 w-4 text-gray-500" />{t('admin.conceptQuality.mergeTitle')}<HelpTip id="concepts.merge" />
          </h3>
          <button
            type="button"
            onClick={findSuggestions}
            disabled={searching}
            className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            data-testid="button-find-merge-suggestions"
          >
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {t('admin.conceptQuality.findButton')}
          </button>
        </div>
        {autoMerged > 0 && (
          <p className="mb-2 text-xs text-green-700" data-testid="text-auto-merged">{t('admin.conceptQuality.autoMerged', { n: String(autoMerged) })}</p>
        )}
        {error && <p className="mb-2 flex items-start gap-1.5 text-xs text-red-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{error}</p>}
        {suggestions === null ? (
          <p className="text-xs text-gray-500">{t('admin.conceptQuality.intro')}</p>
        ) : suggestions.length === 0 ? (
          <p className="text-xs text-gray-500" data-testid="text-no-merge-suggestions">{t('admin.conceptQuality.none')}</p>
        ) : (
          <ul className="space-y-2" data-testid="list-merge-suggestions">
            {suggestions.map(s => (
              <li key={s.keep.id} className="rounded-lg bg-gray-50 p-2.5 text-xs ring-1 ring-gray-200">
                <p className="text-gray-700" data-testid={`text-merge-suggestion-${s.keep.id}`}>
                  {t(s.kind === 'crossClass' ? 'admin.conceptQuality.suggestionCrossClass' : 'admin.conceptQuality.suggestion', { others: s.others.map(o => `“${o.name}”`).join(', '), keep: `“${s.keep.name}”` })}
                </p>
                <fieldset className="mt-2">
                  <legend className="mb-1 font-medium text-gray-700">{t('admin.conceptQuality.keepNameLabel')}</legend>
                  <div className="flex flex-col gap-1">
                    {membersOf(s).map(m => (
                      <label key={m.id} className="flex min-w-0 cursor-pointer items-center gap-2 text-gray-700">
                        <input
                          type="radio"
                          name={`keep-${s.keep.id}`}
                          checked={chosenOf(s).id === m.id}
                          onChange={() => setChosen(prev => ({ ...prev, [s.keep.id]: m.id }))}
                          className="h-3.5 w-3.5 flex-shrink-0 accent-blue-600"
                          data-testid={`radio-keep-${s.keep.id}-${m.id}`}
                        />
                        <span className="min-w-0 break-words">{m.name}</span>
                        {m.cls && <span className="flex-shrink-0 text-[11px] text-gray-500">{classLabel[m.cls]}</span>}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => merge(s)}
                    disabled={busyId === s.keep.id}
                    className="inline-flex min-w-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-left font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    data-testid={`button-merge-${s.keep.id}`}
                  >
                    {busyId === s.keep.id ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" /> : <GitMerge className="h-3 w-3 flex-shrink-0" />}
                    {t('admin.conceptQuality.mergeAs', { name: `“${chosenOf(s).name}”` })}
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(s)}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-100"
                    data-testid={`button-dismiss-${s.keep.id}`}
                  >
                    <X className="h-3 w-3" />{t('admin.conceptQuality.dismissButton')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
