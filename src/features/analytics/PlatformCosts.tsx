// "Kosten en gebruik" (alleen beheerder; 2026-11-25): tokens per dag voor heel
// LEAP of één cursus, met een omrekening naar euro's, verbruik per groep
// (studenten / voorbereiding door docenten / achtergrond), per cursus, en het
// aantal actieve gebruikers per dag. Alleen totalen; nooit per persoon.
import { useState } from 'react';
import { Coins, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { useApi, Tile, fmt } from './shared';
import { DailyBars } from './DailyBars';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
type Group = 'students' | 'teachers' | 'background' | 'other';
const GROUPS: Group[] = ['students', 'teachers', 'background', 'other'];

export interface DailyPlatform {
  available: boolean;
  courseId: string | null;
  measuredSince: string | null;
  /** students is null bij één cursus met minder dan 5 actieve studenten (privacy). */
  days: Array<{ day: string; tokens: number; groups: Record<Group, number>; students: number | null; staff: number }>;
  totalTokens: number;
  groups: Record<Group, number>;
  parts: Array<{ key: string; group: Group; tokens: number }>;
  courses: Array<{ courseId: string | null; name: string | null; tokens: number }>;
}

// Prijs per miljoen tokens: alleen in deze browser onthouden (gemak, geen gedeelde instelling).
const PRICE_KEY = 'leap.analytics.pricePerMillion';
function readPrice(): number | null {
  try {
    const v = Number(localStorage.getItem(PRICE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

export function PlatformCosts({ weeks }: { weeks: number }) {
  const { t, lang } = useLanguage();
  const tk = (key: string, v?: Record<string, string>) => t(key as TKey, v);
  const [courseId, setCourseId] = useState('');
  const [price, setPrice] = useState<number | null>(readPrice);
  const url = `/api/analytics/platform?weeks=${weeks}${courseId ? `&courseId=${courseId}` : ''}`;
  const { data, error, loading, load } = useApi<{ daily: DailyPlatform; courses: Array<{ id: string; name: string }> }>(url);
  const d = data?.daily;
  // Leesbare naam voor een serveronderdeel; onbekend = de technische naam.
  const featureLabel = (key: string) => {
    const k = `analytics.feature.${key.replace(/[^a-z0-9]+/gi, '_')}`;
    const label = tk(k);
    return label === k ? key : label;
  };

  const money = (tokens: number) => (price
    ? new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: tokens * price / 1e6 < 10 ? 2 : 0 }).format((tokens / 1e6) * price)
    : null);
  const savePrice = (raw: string) => {
    const v = Number(raw.replace(',', '.'));
    const next = Number.isFinite(v) && v > 0 ? v : null;
    setPrice(next);
    try { if (next) localStorage.setItem(PRICE_KEY, String(next)); else localStorage.removeItem(PRICE_KEY); } catch { /* geen opslag: alleen deze sessie */ }
  };
  const days = (d?.days || []).filter((x) => d?.measuredSince && x.day >= d.measuredSince);
  const today = days[days.length - 1];
  const avgTokens = days.length ? Math.round(days.reduce((s, x) => s + x.tokens, 0) / days.length) : 0;
  const maxGroup = Math.max(1, ...GROUPS.map((g) => d?.groups[g] || 0));
  const studentsText = (n: number | null) => (n == null ? t('analytics.lessThanK', { k: '5' }) : fmt(n, lang));

  return (
    <section className="space-y-4" data-testid="section-costs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2 min-w-0">
          <Coins className="w-5 h-5 text-brand-600" />
          {t('analytics.costs.title')}
          <HelpTip id="analytics.costs" />
        </h3>
        <button onClick={load} disabled={loading}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          data-testid="button-refresh-costs">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('analytics.refresh')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700">
        <label className="flex items-center gap-2 min-w-0">
          {t('analytics.costs.scope')}
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)} className="min-w-0 max-w-[16rem] border border-gray-200 rounded-lg px-2 py-1" data-testid="select-costs-course">
            <option value="">{t('analytics.costs.allLeap')}</option>
            {(data?.courses || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          {t('analytics.costs.price')}
          <input
            type="text"
            inputMode="decimal"
            defaultValue={price ?? ''}
            onBlur={(e) => savePrice(e.target.value)}
            placeholder="—"
            className="w-20 border border-gray-200 rounded-lg px-2 py-1"
            data-testid="input-costs-price"
          />
        </label>
      </div>

      {error && <AdminHint variant="warning" testId="text-costs-error">{t('analytics.error', { message: error })}</AdminHint>}
      {loading && !data && <p className="text-sm text-gray-500">{t('common.busy')}</p>}
      {d && !d.measuredSince && <p className="text-sm text-gray-500" data-testid="text-costs-not-measured">{t('analytics.costs.notMeasuredYet')}</p>}

      {d && d.measuredSince && (
        <>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))]">
            <Tile testId="tile-costs-total" label={t('analytics.costs.totalTokens')} value={fmt(d.totalTokens, lang)} sub={money(d.totalTokens) || undefined} />
            <Tile testId="tile-costs-avg" label={t('analytics.costs.avgPerDay')} value={fmt(avgTokens, lang)} sub={money(avgTokens) || undefined} />
            <Tile testId="tile-costs-today" label={t('analytics.costs.today')} value={fmt(today?.tokens || 0, lang)} sub={money(today?.tokens || 0) || undefined} />
            <Tile testId="tile-users-today" label={t('analytics.costs.usersToday')} value={today?.students == null ? '—' : fmt(today.students + today.staff, lang)}
              sub={t('analytics.costs.usersSplit', { students: studentsText(today?.students ?? 0), staff: fmt(today?.staff || 0, lang) })} />
          </div>

          <div className="chic-card p-4 space-y-3" data-testid="block-tokens-daily">
            <h4 className="text-sm font-semibold text-gray-700">{t('analytics.costs.tokensPerDay')}</h4>
            <DailyBars
              testId="chart-tokens-daily"
              bars={days.map((x) => ({
                day: x.day,
                value: x.tokens,
                detail: [
                  ...(money(x.tokens) ? [money(x.tokens)!] : []),
                  ...GROUPS.filter((g) => x.groups[g] > 0).map((g) => `${tk(`analytics.costs.group.${g}`)}: ${fmt(x.groups[g], lang)}`),
                ],
              }))}
              label={t('analytics.costs.tokensPerDay')}
              format={(n) => t('analytics.costs.tokensN', { n: fmt(n, lang) })}
              suppressedText="—"
              lang={lang}
            />
          </div>

          <div className="chic-card p-4 space-y-3" data-testid="block-users-daily">
            <h4 className="text-sm font-semibold text-gray-700">{t('analytics.costs.usersPerDay')}</h4>
            <DailyBars
              testId="chart-users-daily"
              bars={days.map((x) => ({
                day: x.day,
                value: x.students == null ? null : x.students + x.staff,
                suppressed: x.students == null,
                detail: [t('analytics.costs.usersSplit', { students: studentsText(x.students), staff: fmt(x.staff, lang) })],
              }))}
              label={t('analytics.costs.usersPerDay')}
              format={(n) => t('analytics.costs.usersN', { n: fmt(n, lang) })}
              suppressedText={t('analytics.usage.hiddenSmallDiff')}
              lang={lang}
              height={110}
            />
          </div>

          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
            <div className="chic-card p-4 space-y-2 min-w-0" data-testid="block-tokens-groups">
              <h4 className="text-sm font-semibold text-gray-700">{t('analytics.costs.perGroup')}</h4>
              <ul className="space-y-2">
                {GROUPS.filter((g) => d.groups[g] > 0).map((g) => (
                  <li key={g} className="space-y-0.5" data-testid={`row-group-${g}`}>
                    <div className="flex gap-2 text-sm">
                      <span className="min-w-0 truncate">{tk(`analytics.costs.group.${g}`)}</span>
                      <span className="ml-auto whitespace-nowrap text-gray-700">{fmt(d.groups[g], lang)}{money(d.groups[g]) ? ` · ${money(d.groups[g])}` : ''}</span>
                    </div>
                    <div className="h-2.5 rounded bg-gray-100 overflow-hidden">
                      <div className="h-full rounded bg-brand-500" style={{ width: `${Math.max((d.groups[g] / maxGroup) * 100, 2)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              <details className="text-xs text-gray-600">
                <summary className="cursor-pointer">{t('analytics.costs.perPartDetails')}</summary>
                <ul className="mt-2 space-y-0.5">
                  {d.parts.map((p) => (
                    <li key={p.key} className="flex gap-2 min-w-0">
                      <span className="min-w-0 truncate">{featureLabel(p.key)}</span>
                      <span className="ml-auto whitespace-nowrap">{fmt(p.tokens, lang)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>

            {!courseId && (
              <div className="chic-card p-4 space-y-2 min-w-0" data-testid="block-tokens-courses">
                <h4 className="text-sm font-semibold text-gray-700">{t('analytics.costs.perCourse')}</h4>
                <ul className="text-sm space-y-1">
                  {d.courses.map((c) => (
                    <li key={c.courseId || 'none'} className="flex gap-2 min-w-0">
                      {c.courseId ? (
                        <button type="button" onClick={() => setCourseId(c.courseId!)} className="min-w-0 truncate text-left text-brand-700 hover:underline">{c.name || '—'}</button>
                      ) : (
                        <span className="min-w-0 truncate">{t('analytics.platform.noCourse')}</span>
                      )}
                      <span className="ml-auto whitespace-nowrap text-gray-700">{fmt(c.tokens, lang)}{money(c.tokens) ? ` · ${money(c.tokens)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500">{t('analytics.costs.measuredSince', { date: new Date(`${d.measuredSince}T12:00:00Z`).toLocaleDateString(lang) })}</p>
        </>
      )}
    </section>
  );
}
