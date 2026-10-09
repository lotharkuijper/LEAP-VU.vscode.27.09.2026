// Analytics — tabblad "Analyse" in het beheer. Losse module: zie
// server/analytics/index.js voor alle plekken waar deze functie aan LEAP raakt.
//
// Alleen geaggregeerde cijfers. Een quizcijfer dat op minder dan k studenten
// berust, komt als `null` van de server en wordt hier als "< k" getoond.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, RefreshCw, Thermometer } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';

export interface ConceptRow {
  name: string;
  quiz: { attempts: number | null; avgScore: number | null; suppressed: boolean };
  chat: { asked: number; misses: number };
}
export interface ThermometerData {
  since: string;
  measuredSince: string | null;
  k: number;
  quiz: { attempts: number | null; avgScore: number | null; suppressed: boolean };
  chat: { hit: number; miss: number };
  concepts: ConceptRow[];
  weekly: Array<{ week: string; avgScore: number | null; attempts: number | null; suppressed?: boolean }>;
}
export interface PlatformData {
  since: string;
  parts: Array<{ key: string; requests: number; errors: number; slow: number; avgMs: number | null; errorRate: number | null; llmCalls: number; tokens: number }>;
  totals: { requests: number; errors: number; tokens: number; llmCalls: number };
  tokensByCourse: Array<{ courseId: string | null; name: string | null; tokens: number }>;
  tokensByWeek: Array<{ week: string; tokens: number }>;
  ingestion: Array<{ courseId: string; name: string; active: boolean; documents: number; failed: number; busy: number; noChunks: number; singleGiantChunk: number; bytes: number; chunks: number }>;
}

const PERIODS = [4, 8, 16, 52];

function useApi<T>(url: string | null) {
  const { session } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!url || !session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d as T);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url, session?.access_token]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, load };
}

function scoreColor(score: number) {
  if (score < 55) return 'bg-red-400';
  if (score < 70) return 'bg-amber-400';
  return 'bg-accent-500';
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="chic-card p-3 min-w-0" data-testid={testId}>
      <div className="text-xs text-gray-500 truncate">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

function fmt(n: number, lang: string) {
  return new Intl.NumberFormat(lang).format(n);
}

// ── Begrippen-thermometer (docent, eigen cursus) ──────────────────────────────
export function ConceptThermometer({ weeks, onOpenMaterial }: { weeks: number; onOpenMaterial?: () => void }) {
  const { t, lang } = useLanguage();
  const { activeCourseId, activeCourse } = useActiveCourse();
  const url = activeCourseId ? `/api/analytics/courses/${activeCourseId}/concepts?weeks=${weeks}` : null;
  const { data, error, loading, load } = useApi<ThermometerData>(url);
  const [sort, setSort] = useState<'attention' | 'name'>('attention');
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    // Standaard alleen begrippen waarover iets te zeggen valt.
    const hasData = (c: ConceptRow) => c.quiz.avgScore != null || c.quiz.suppressed || c.chat.asked > 0;
    const list = (data?.concepts || []).filter(c => showAll || hasData(c));
    if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name, lang));
    // Meeste aandacht nodig: laagste quizscore eerst, dan meeste vragen zonder bewijs.
    const s = (c: ConceptRow) => (c.quiz.avgScore ?? 101);
    return list.sort((a, b) => (s(a) - s(b)) || (b.chat.misses - a.chat.misses) || a.name.localeCompare(b.name, lang));
  }, [data, sort, lang, showAll]);
  const gaps = (data?.concepts || []).filter(c => c.chat.misses > 0).sort((a, b) => b.chat.misses - a.chat.misses).slice(0, 8);

  if (!activeCourseId) return <AdminHint variant="intro">{t('analytics.noCourse')}</AdminHint>;
  const k = data?.k ?? 5;
  const chatTotal = (data?.chat.hit || 0) + (data?.chat.miss || 0);
  const lessThanK = t('analytics.lessThanK', { k: String(k) });

  return (
    <section className="space-y-4" data-testid="section-thermometer">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2 min-w-0">
          <Thermometer className="w-5 h-5 text-brand-600" />
          {t('analytics.thermometer.title', { course: activeCourse?.name || '' })}
          <HelpTip id="analytics.thermometer" />
        </h3>
        <button onClick={load} disabled={loading}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          data-testid="button-refresh-thermometer">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('analytics.refresh')}
        </button>
      </div>

      {error && <AdminHint variant="warning" testId="text-thermometer-error">{t('analytics.error', { message: error })}</AdminHint>}
      {loading && !data && <p className="text-sm text-gray-500">{t('common.busy')}</p>}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))]">
            <Tile testId="tile-quiz-avg" label={t('analytics.thermometer.quizAvg')}
              value={data.quiz.avgScore != null ? `${data.quiz.avgScore}%` : '—'}
              sub={data.quiz.attempts != null ? t('analytics.thermometer.attempts', { n: fmt(data.quiz.attempts, lang) }) : (data.quiz.suppressed ? lessThanK : undefined)} />
            <Tile testId="tile-chat-evidence" label={t('analytics.thermometer.chatWithEvidence')}
              value={chatTotal ? `${Math.round((data.chat.hit / chatTotal) * 100)}%` : '—'}
              sub={t('analytics.thermometer.chatQuestions', { n: fmt(chatTotal, lang) })} />
            <Tile testId="tile-chat-miss" label={t('analytics.thermometer.chatWithoutEvidence')}
              value={fmt(data.chat.miss, lang)} />
          </div>

          {gaps.length > 0 && (
            <div className="chic-card p-4 space-y-2" data-testid="block-gaps">
              <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />{t('analytics.thermometer.gapsTitle')}
              </h4>
              <AdminHint variant="tip">{t('analytics.thermometer.gapsHint')}</AdminHint>
              <ul className="text-sm space-y-1">
                {gaps.map(c => (
                  <li key={c.name} className="flex gap-2 min-w-0" data-testid={`row-gap-${c.name}`}>
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="ml-auto whitespace-nowrap text-gray-500">{t('analytics.thermometer.missCount', { n: String(c.chat.misses), total: String(c.chat.asked) })}</span>
                  </li>
                ))}
              </ul>
              {onOpenMaterial && (
                <button onClick={onOpenMaterial} className="text-sm text-brand-700 hover:underline" data-testid="button-open-material">
                  {t('analytics.thermometer.openMaterial')}
                </button>
              )}
            </div>
          )}

          <div className="chic-card p-4" data-testid="block-concepts">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <h4 className="text-sm font-semibold text-gray-700">{t('analytics.thermometer.perConcept')}</h4>
              <select value={sort} onChange={e => setSort(e.target.value as 'attention' | 'name')}
                className="ml-auto text-sm border border-gray-200 rounded-lg px-2 py-1" data-testid="select-thermometer-sort"
                aria-label={t('analytics.thermometer.sortLabel')}>
                <option value="attention">{t('analytics.thermometer.sortAttention')}</option>
                <option value="name">{t('analytics.thermometer.sortName')}</option>
              </select>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-500" data-testid="text-concepts-empty">
                {data.concepts.length === 0 ? t('analytics.thermometer.noConcepts') : t('analytics.thermometer.noData')}
              </p>
            ) : (
              <div className="space-y-2">
                <div className="hidden sm:flex gap-3 text-xs text-gray-400">
                  <div className="w-[40%] min-w-0">{t('analytics.thermometer.colConcept')}</div>
                  <div className="flex-1">{t('analytics.thermometer.colQuiz')}</div>
                  <div className="w-28 text-right">{t('analytics.thermometer.colChat')}</div>
                </div>
                {rows.map(c => (
                  <div key={c.name} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1" data-testid={`row-concept-${c.name}`}>
                    <div className="w-full sm:w-[40%] min-w-0 truncate text-sm text-gray-800" title={c.name}>{c.name}</div>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      {c.quiz.avgScore != null ? (
                        <>
                          <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                            <div className={`h-full ${scoreColor(c.quiz.avgScore)}`} style={{ width: `${Math.max(c.quiz.avgScore, 3)}%` }} />
                          </div>
                          <span className="w-10 text-right text-sm font-medium text-gray-700">{c.quiz.avgScore}%</span>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400" data-testid={`text-quiz-hidden-${c.name}`}>
                          {c.quiz.suppressed ? lessThanK : t('analytics.thermometer.noQuiz')}
                        </span>
                      )}
                    </div>
                    <div className="w-28 text-right text-xs text-gray-500 whitespace-nowrap">
                      {c.chat.asked > 0 ? t('analytics.thermometer.chatCell', { n: String(c.chat.asked), miss: String(c.chat.misses) }) : '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {data.concepts.length > 0 && (
              <button onClick={() => setShowAll(v => !v)} className="mt-3 text-sm text-brand-700 hover:underline" data-testid="button-toggle-all-concepts">
                {showAll ? t('analytics.thermometer.showWithData') : t('analytics.thermometer.showAll', { n: String(data.concepts.length) })}
              </button>
            )}
          </div>

          <p className="text-xs text-gray-400" data-testid="text-measured-since">
            {data.measuredSince
              ? t('analytics.thermometer.measuredSince', { date: new Date(data.measuredSince).toLocaleDateString(lang) })
              : t('analytics.thermometer.notMeasuredYet')}
          </p>
        </>
      )}
    </section>
  );
}

// ── Gezondheid en kosten (alleen beheerder) ───────────────────────────────────
export function PlatformHealth({ weeks }: { weeks: number }) {
  const { t, lang } = useLanguage();
  const { data, error, loading, load } = useApi<PlatformData>(`/api/analytics/platform?weeks=${weeks}`);
  const maxWeek = Math.max(1, ...(data?.tokensByWeek || []).map(w => w.tokens));
  const problems = (data?.ingestion || []).filter(r => r.failed || r.noChunks || r.singleGiantChunk || r.busy);

  return (
    <section className="space-y-4" data-testid="section-platform">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2 min-w-0">
          <Activity className="w-5 h-5 text-brand-600" />
          {t('analytics.platform.title')}
          <HelpTip id="analytics.platform" />
        </h3>
        <button onClick={load} disabled={loading}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          data-testid="button-refresh-platform">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('analytics.refresh')}
        </button>
      </div>

      {error && <AdminHint variant="warning" testId="text-platform-error">{t('analytics.error', { message: error })}</AdminHint>}
      {loading && !data && <p className="text-sm text-gray-500">{t('common.busy')}</p>}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))]">
            <Tile testId="tile-requests" label={t('analytics.platform.requests')} value={fmt(data.totals.requests, lang)} />
            <Tile testId="tile-errors" label={t('analytics.platform.errorRate')}
              value={data.totals.requests ? new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(data.totals.errors / data.totals.requests) : '—'}
              sub={t('analytics.platform.errors', { n: fmt(data.totals.errors, lang) })} />
            <Tile testId="tile-llm-calls" label={t('analytics.platform.llmCalls')} value={fmt(data.totals.llmCalls, lang)} />
            <Tile testId="tile-tokens" label={t('analytics.platform.tokens')} value={fmt(data.totals.tokens, lang)} />
          </div>

          {data.tokensByWeek.length > 0 && (
            <div className="chic-card p-4" data-testid="block-tokens-week">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{t('analytics.platform.tokensPerWeek')}</h4>
              <div className="space-y-1.5">
                {data.tokensByWeek.map(w => (
                  <div key={w.week} className="flex items-center gap-3">
                    <div className="w-24 shrink-0 text-xs text-gray-500">{new Date(w.week).toLocaleDateString(lang)}</div>
                    <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                      <div className="h-full bg-brand-400" style={{ width: `${Math.max((w.tokens / maxWeek) * 100, 2)}%` }} />
                    </div>
                    <div className="w-24 shrink-0 text-right text-xs text-gray-600">{fmt(w.tokens, lang)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
            <div className="chic-card p-4 min-w-0" data-testid="block-tokens-course">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('analytics.platform.tokensPerCourse')}</h4>
              {data.tokensByCourse.length === 0 ? <p className="text-sm text-gray-500">—</p> : (
                <ul className="text-sm space-y-1">
                  {data.tokensByCourse.map(c => (
                    <li key={c.courseId || 'none'} className="flex gap-2 min-w-0">
                      <span className="min-w-0 truncate">{c.name || t('analytics.platform.noCourse')}</span>
                      <span className="ml-auto whitespace-nowrap text-gray-600">{fmt(c.tokens, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="chic-card p-4 min-w-0" data-testid="block-parts">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('analytics.platform.perPart')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-400">
                    <tr>
                      <th className="text-left font-normal py-1">{t('analytics.platform.colPart')}</th>
                      <th className="text-right font-normal">{t('analytics.platform.colRequests')}</th>
                      <th className="text-right font-normal">{t('analytics.platform.colAvgMs')}</th>
                      <th className="text-right font-normal">{t('analytics.platform.colErrors')}</th>
                      <th className="text-right font-normal">{t('analytics.platform.colTokens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.parts.slice(0, 25).map(p => (
                      <tr key={p.key} className="border-t border-gray-100" data-testid={`row-part-${p.key}`}>
                        <td className="py-1 font-mono text-gray-700">{p.key}</td>
                        <td className="text-right">{fmt(p.requests, lang)}</td>
                        <td className="text-right">{p.avgMs != null ? fmt(p.avgMs, lang) : '—'}</td>
                        <td className={`text-right ${p.errors ? 'text-red-600 font-medium' : ''}`}>{p.errors || '—'}</td>
                        <td className="text-right">{p.tokens ? fmt(p.tokens, lang) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="chic-card p-4" data-testid="block-ingestion">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('analytics.platform.ingestionTitle')}</h4>
            {problems.length === 0 ? (
              <p className="text-sm text-accent-700" data-testid="text-ingestion-ok">{t('analytics.platform.ingestionOk')}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {problems.map(r => (
                  <li key={r.courseId} className="flex flex-wrap gap-x-3 min-w-0" data-testid={`row-ingestion-${r.courseId}`}>
                    <span className="min-w-0 truncate font-medium">{r.name}</span>
                    {r.failed > 0 && <span className="text-red-600 whitespace-nowrap">{t('analytics.platform.failed', { n: String(r.failed) })}</span>}
                    {r.noChunks > 0 && <span className="text-red-600 whitespace-nowrap">{t('analytics.platform.noChunks', { n: String(r.noChunks) })}</span>}
                    {r.singleGiantChunk > 0 && <span className="text-amber-600 whitespace-nowrap">{t('analytics.platform.giantChunk', { n: String(r.singleGiantChunk) })}</span>}
                    {r.busy > 0 && <span className="text-gray-500 whitespace-nowrap">{t('analytics.platform.busy', { n: String(r.busy) })}</span>}
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-3 text-xs text-gray-500">
              <summary className="cursor-pointer">{t('analytics.platform.storageTitle')}</summary>
              <ul className="mt-2 space-y-1">
                {(data.ingestion || []).map(r => (
                  <li key={r.courseId} className="flex gap-2 min-w-0">
                    <span className="min-w-0 truncate">{r.name}</span>
                    <span className="ml-auto whitespace-nowrap">
                      {t('analytics.platform.storageRow', { docs: String(r.documents), mb: (r.bytes / 1048576).toFixed(1), chunks: fmt(r.chunks, lang) })}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <p className="text-xs text-gray-400">
            {data.since ? t('analytics.platform.measuredFrom', { date: new Date(data.since).toLocaleDateString(lang) }) : ''}
          </p>
        </>
      )}
    </section>
  );
}

export function AnalyticsAdminTab({ onOpenMaterial }: { onOpenMaterial?: () => void }) {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const [weeks, setWeeks] = useState(8);

  return (
    <div className="space-y-8" data-testid="panel-analytics">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-[18rem]">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-brand-600" />
            {t('analytics.title')}
          </h2>
          <AdminHint variant="intro" className="mt-1">{t('analytics.intro')}</AdminHint>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap">
          {t('analytics.period')}
          <select value={weeks} onChange={e => setWeeks(Number(e.target.value))}
            className="border border-gray-200 rounded-lg px-2 py-1" data-testid="select-analytics-period">
            {PERIODS.map(w => <option key={w} value={w}>{t('analytics.weeks', { n: String(w) })}</option>)}
          </select>
        </label>
      </div>

      <ConceptThermometer weeks={weeks} onOpenMaterial={onOpenMaterial} />
      {isAdmin && <PlatformHealth weeks={weeks} />}
    </div>
  );
}
