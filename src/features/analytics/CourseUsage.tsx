// "Gebruik door studenten" (docent, eigen cursus; 2026-11-25): actieve studenten
// per dag en week, welke onderdelen ze gebruiken, behaalde achievements en
// actieve projectgroepen. Alleen totalen; onder k studenten komt `null` van de
// server en staat hier "minder dan k".
import { RefreshCw, Users, LayoutGrid, Award, UsersRound } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { useApi, Tile, fmt } from './shared';
import { DailyBars } from './DailyBars';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export interface UsageData {
  since: string;
  editionStart?: string | null;
  dailyAvailable: boolean;
  measuredSince: string | null;
  k: number;
  enrolled: number;
  daily: Array<{ day: string; activeStudents: number | null; suppressed: boolean }>;
  weekly: Array<{ week: string; activeStudents: number | null; suppressed: boolean; share: number | null }>;
  parts: Array<{ part: string; weeks: Array<{ week: string; students: number | null; suppressed: boolean }>; actions: number | null; share: number | null }>;
  groups: { total: number; suppressed: boolean; weeks: Array<{ week: string; activeGroups: number | null; suppressed: boolean }> | null };
  achievements: {
    k: number; suppressed: boolean; total: number | null; students: number | null; share: number | null;
    kinds: Array<{ kind: string; count: number | null; students: number | null; suppressed: boolean }>;
    weeks: Array<{ week: string; count: number | null; suppressed: boolean }>;
  };
}

export function CourseUsage({ weeks }: { weeks: number }) {
  const { t, lang } = useLanguage();
  const tk = (key: string, v?: Record<string, string>) => t(key as TKey, v);
  const { activeCourseId, activeCourse } = useActiveCourse();
  const url = activeCourseId ? `/api/analytics/courses/${activeCourseId}/usage?weeks=${weeks}` : null;
  const { data, error, loading, load } = useApi<UsageData>(url);
  if (!activeCourseId) return null;

  const k = data?.k ?? 5;
  const lessThanK = t('analytics.lessThanK', { k: String(k) });
  // Verborgen = minder dan k studenten, of op minder dan k na iedereen (beide herleidbaar).
  const hidden = t('analytics.usage.hiddenSmallDiff');
  const pct = (x: number) => new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 }).format(x);
  const weekLabel = (w: string) => new Date(`${w}T12:00:00Z`).toLocaleDateString(lang, { day: 'numeric', month: 'short' });

  // Gemiddelde over de dagen sinds de eerste meting; verborgen dagen (< k) tellen niet mee.
  const measured = (data?.daily || []).filter((d) => data?.measuredSince && d.day >= data.measuredSince);
  const shownDays = measured.filter((d) => d.activeStudents != null);
  const avgPerDay = shownDays.length ? Math.round(shownDays.reduce((s, d) => s + (d.activeStudents || 0), 0) / shownDays.length) : null;
  const thisWeek = data?.weekly[data.weekly.length - 1];
  const lastWeekOf = (p: UsageData['parts'][number]) => p.weeks[p.weeks.length - 1];
  const parts = (data?.parts || []).filter((p) => p.actions != null || p.weeks.some((w) => w.suppressed));

  return (
    <section className="space-y-4" data-testid="section-usage">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2 min-w-0">
          <Users className="w-5 h-5 text-brand-600" />
          {t('analytics.usage.title', { course: activeCourse?.name || '' })}
          <HelpTip id="analytics.usage" />
        </h3>
        <button onClick={load} disabled={loading}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          data-testid="button-refresh-usage">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('analytics.refresh')}
        </button>
      </div>

      {error && <AdminHint variant="warning" testId="text-usage-error">{t('analytics.error', { message: error })}</AdminHint>}
      {loading && !data && <p className="text-sm text-gray-500">{t('common.busy')}</p>}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))]">
            <Tile testId="tile-active-per-day" label={t('analytics.usage.avgPerDay')}
              value={avgPerDay != null ? fmt(avgPerDay, lang) : '—'} sub={measured.length ? t('analytics.usage.overDays', { n: String(measured.length) }) : undefined} />
            <Tile testId="tile-active-this-week" label={t('analytics.usage.thisWeek')}
              value={thisWeek?.activeStudents != null ? fmt(thisWeek.activeStudents, lang) : (thisWeek?.suppressed ? hidden : '—')}
              sub={thisWeek?.share != null ? t('analytics.usage.ofEnrolled', { pct: pct(thisWeek.share) }) : undefined} />
            <Tile testId="tile-enrolled" label={t('analytics.usage.enrolled')} value={fmt(data.enrolled, lang)} />
          </div>

          <div className="chic-card p-4 space-y-3" data-testid="block-active-daily">
            <h4 className="text-sm font-semibold text-gray-700">{t('analytics.usage.activePerDay')}</h4>
            {data.measuredSince ? (
              <DailyBars
                testId="chart-active-daily"
                bars={data.daily.filter((d) => d.day >= data.measuredSince!).map((d) => ({ day: d.day, value: d.activeStudents, suppressed: d.suppressed }))}
                label={t('analytics.usage.activePerDay')}
                format={(n) => t('analytics.usage.students', { n: fmt(n, lang) })}
                suppressedText={hidden}
                lang={lang}
              />
            ) : (
              <p className="text-sm text-gray-500" data-testid="text-usage-not-measured">{t('analytics.usage.notMeasuredYet')}</p>
            )}
            <p className="text-xs text-gray-500">{t('analytics.usage.activeExplain')}</p>
          </div>

          <div className="chic-card p-4 space-y-3" data-testid="block-parts-usage">
            <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><LayoutGrid className="w-4 h-4 text-gray-500" />{t('analytics.usage.partsTitle')}</h4>
            {parts.length === 0 ? <p className="text-sm text-gray-500">{t('analytics.usage.noParts')}</p> : (
              <ul className="space-y-2">
                {parts.sort((a, b) => (b.share ?? -1) - (a.share ?? -1)).map((p) => {
                  const last = lastWeekOf(p);
                  return (
                    <li key={p.part} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`row-usage-part-${p.part}`}>
                      <span className="w-full sm:w-36 shrink-0 text-sm text-gray-800">{tk(`analytics.part.${p.part}`)}</span>
                      <div className="flex-1 min-w-[8rem] h-3 rounded bg-gray-100 overflow-hidden">
                        {p.share != null && <div className="h-full rounded bg-brand-500" style={{ width: `${Math.max(p.share * 100, 2)}%` }} />}
                      </div>
                      <span className="w-12 text-right text-sm font-medium text-gray-700">{p.share != null ? pct(p.share) : '—'}</span>
                      <span className="w-full sm:w-44 text-xs text-gray-500 sm:text-right">
                        {last?.students != null ? t('analytics.usage.studentsThisWeek', { n: fmt(last.students, lang) }) : last?.suppressed ? hidden : '—'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-gray-500">{t('analytics.usage.partsExplain')}</p>
            {parts.length > 0 && (
              <details className="text-xs text-gray-600">
                <summary className="cursor-pointer">{t('analytics.usage.perWeekTable')}</summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full whitespace-nowrap">
                    <thead className="text-gray-500">
                      <tr>
                        <th className="text-left font-normal py-1">{t('analytics.usage.colPart')}</th>
                        {data.weekly.map((w) => <th key={w.week} className="text-right font-normal px-1">{weekLabel(w.week)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-gray-100 font-medium">
                        <td className="py-1">{t('analytics.usage.allParts')}</td>
                        {data.weekly.map((w) => <td key={w.week} className="text-right px-1">{w.activeStudents != null ? w.activeStudents : w.suppressed ? `<${k}` : '—'}</td>)}
                      </tr>
                      {parts.map((p) => (
                        <tr key={p.part} className="border-t border-gray-100">
                          <td className="py-1">{tk(`analytics.part.${p.part}`)}</td>
                          {p.weeks.map((w) => <td key={w.week} className="text-right px-1">{w.students != null ? w.students : w.suppressed ? `<${k}` : '—'}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>

          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
            <div className="chic-card p-4 space-y-2 min-w-0" data-testid="block-achievements">
              <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><Award className="w-4 h-4 text-gray-500" />{t('analytics.usage.achievementsTitle')}</h4>
              {data.achievements.suppressed ? (
                <p className="text-sm text-gray-500" data-testid="text-achievements-hidden">{t('analytics.usage.achievementsHidden', { k: String(k) })}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-800">
                    {t('analytics.usage.achievementsSummary', {
                      total: fmt(data.achievements.total || 0, lang),
                      students: fmt(data.achievements.students || 0, lang),
                      pct: data.achievements.share != null ? pct(data.achievements.share) : '—',
                    })}
                  </p>
                  <ul className="text-sm space-y-1">
                    {data.achievements.kinds.map((a) => (
                      <li key={a.kind} className="flex gap-2 min-w-0" data-testid={`row-achievement-${a.kind}`}>
                        <span className="min-w-0 truncate">{tk(`analytics.achievement.${a.kind}`)}</span>
                        <span className="ml-auto whitespace-nowrap text-gray-600">{a.count != null ? fmt(a.count, lang) : lessThanK}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {data.groups.total > 0 && (
              <div className="chic-card p-4 space-y-2 min-w-0" data-testid="block-groups">
                <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><UsersRound className="w-4 h-4 text-gray-500" />{t('analytics.usage.groupsTitle')}</h4>
                {data.groups.suppressed || !data.groups.weeks ? (
                  <p className="text-sm text-gray-500" data-testid="text-groups-hidden">{t('analytics.usage.groupsHidden', { k: String(k) })}</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {data.groups.weeks.map((w) => (
                      <li key={w.week} className="flex gap-2">
                        <span>{t('analytics.usage.weekOf', { date: weekLabel(w.week) })}</span>
                        <span className="ml-auto text-gray-600">{w.activeGroups != null ? t('analytics.usage.groupsActive', { n: fmt(w.activeGroups, lang), total: fmt(data.groups.total, lang) }) : t('analytics.usage.hiddenSmallDiff')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
