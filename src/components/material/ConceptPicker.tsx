import { useMemo, useState } from 'react';
import { ListChecks, ChevronDown, ChevronUp, Search, Eye, EyeOff, Trash2, Info, AlertTriangle, Loader2, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { ListRow } from '../ui/ListRow';
import { RowActions } from '../ui/RowActions';
import { AdminHint } from '../help/AdminHint';
import { HelpTip } from '../help/HelpTip';
import {
  buildPickerRows, filterRows, countsFor, summarize, NO_FILTERS, KIND_ORDER, TIER_ORDER, STATUS_ORDER,
  type PickerConcept, type PickerFilters, type Visibility,
} from '../../lib/conceptPicker';

// "Begrippen kiezen" (src/lib/conceptPicker.ts): bovenaan de Begrippen-stap een
// overzicht van wat studenten krijgen, met een knop die de keuzelijst opent.
// Elke schakelaar slaat meteen op; bulkacties gelden alleen voor wat in beeld is.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

interface Props {
  courseId: string;
  token: string;
  concepts: PickerConcept[];
  moduleCounts: Record<string, number>;
  onChanged: () => Promise<void> | void;
  onOpenDetails?: (id: string) => void;
}

const TIER_DOT: Record<string, string> = { hard: 'bg-red-500', medium: 'bg-yellow-500', easy: 'bg-green-500' };
const KIND_BADGE: Record<string, string> = {
  course: 'bg-purple-50 text-purple-700 border-purple-200',
  module: 'bg-blue-50 text-blue-700 border-blue-200',
  example: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function ConceptPicker({ courseId, token, concepts, moduleCounts, onChanged, onOpenDetails }: Props) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<PickerFilters>(NO_FILTERS);
  // Direct zichtbaar resultaat terwijl de server opslaat (en bij een fout terug).
  const [override, setOverride] = useState<Record<string, Visibility>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);

  const rows = useMemo(() => buildPickerRows(
    concepts.map((c) => (override[c.id] ? { ...c, review_status: override[c.id] === 'visible' ? 'approved' : 'rejected' } : c)),
    moduleCounts,
  ), [concepts, moduleCounts, override]);
  const shown = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const sum = summarize(rows);
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  const post = async (url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;
  };

  const setVisible = async (ids: string[], visible: boolean) => {
    if (ids.length === 0) return;
    setError(null);
    setOverride((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, visible ? 'visible' : 'hidden'] as const)) }));
    setBusy(true);
    try {
      await post('/api/admin/concepts/visibility', { method: 'POST', body: JSON.stringify({ courseId, ids, visible }) });
      await onChanged();
    } catch (e) {
      setError(tk('admin.conceptPicker.saveError', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setOverride((prev) => { const next = { ...prev }; for (const id of ids) delete next[id]; return next; });
      setBusy(false);
    }
  };

  const remove = async (ids: string[]) => {
    setConfirmDelete(null);
    setError(null);
    setBusy(true);
    const results = await Promise.allSettled(ids.map((id) => post(`/api/admin/concepts/${id}`, { method: 'DELETE' })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) setError(tk('admin.concepts.bulkDeleteError', { failed: String(failed), total: String(ids.length) }));
    await onChanged();
    setBusy(false);
  };

  const chip = (active: boolean, label: string, n: number | undefined, onClick: () => void, testId: string) => (
    <button
      key={testId}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${active ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400'}`}
      data-testid={testId}
    >
      {label} <span className={active ? 'text-white/80' : 'text-gray-400'}>{n ?? 0}</span>
    </button>
  );

  const kindCounts = countsFor(rows, filters, 'kind');
  const tierCounts = countsFor(rows, filters, 'tier');
  const statusCounts = countsFor(rows, filters, 'status');
  const shownIds = shown.map((r) => r.concept.id);

  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/40 p-4" data-testid="panel-concept-picker">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 font-semibold text-gray-900">
            <ListChecks className="h-5 w-5 text-blue-600" aria-hidden />
            {t('admin.conceptPicker.title')}
            <HelpTip id="concepts.picker" />
          </h3>
          <p className="text-sm text-gray-700" data-testid="text-concept-summary">
            {tk('admin.conceptPicker.summary', { visible: String(sum.visible), total: String(sum.total) })}
            {sum.review > 0 && <> · <span className="font-medium text-amber-700">{tk('admin.conceptPicker.summaryReview', { n: String(sum.review) })}</span></>}
            {sum.hidden > 0 && <> · {tk('admin.conceptPicker.summaryHidden', { n: String(sum.hidden) })}</>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex whitespace-nowrap items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700"
          data-testid="button-open-concept-picker"
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {open ? t('admin.conceptPicker.close') : tk('admin.conceptPicker.open', { n: String(sum.total) })}
        </button>
      </div>

      {!open && sum.review > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-800" data-testid="text-concept-review-hint">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">{tk('admin.conceptPicker.reviewHint', { n: String(sum.review) })}</span>
          <button type="button" className="font-medium underline hover:no-underline" onClick={() => { setFilters({ ...NO_FILTERS, status: 'review' }); setOpen(true); }}>
            {t('admin.conceptPicker.reviewShow')}
          </button>
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <AdminHint variant="tip">{t('admin.conceptPicker.intro')}</AdminHint>

          <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
            {([
              ['kind', 'admin.conceptPicker.filterKind', KIND_ORDER, kindCounts],
              ['tier', 'admin.conceptPicker.filterTier', TIER_ORDER, tierCounts],
              ['status', 'admin.conceptPicker.filterStatus', STATUS_ORDER, statusCounts],
            ] as const).map(([dim, labelKey, values, counts]) => (
              <div key={dim} className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 shrink-0 text-xs font-medium text-gray-500">{tk(labelKey)}</span>
                {chip(filters[dim] === 'all', t('admin.conceptPicker.all'), counts.all, () => setFilters((f) => ({ ...f, [dim]: 'all' })), `chip-${dim}-all`)}
                {(values as readonly string[]).map((v) => chip(
                  filters[dim] === v, tk(`admin.conceptPicker.${dim}.${v}`), counts[v],
                  () => setFilters((f) => ({ ...f, [dim]: v })), `chip-${dim}-${v}`,
                ))}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-gray-400" aria-hidden />
                <input
                  type="search"
                  value={filters.q}
                  onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                  placeholder={t('admin.conceptPicker.search')}
                  aria-label={t('admin.conceptPicker.search')}
                  className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-2 text-sm"
                  data-testid="input-concept-search"
                />
              </label>
              {filtered && (
                <button type="button" onClick={() => setFilters(NO_FILTERS)} className="flex whitespace-nowrap items-center gap-1 text-xs text-gray-600 hover:text-gray-900" data-testid="button-reset-concept-filters">
                  <X className="h-3.5 w-3.5" /> {t('admin.conceptPicker.resetFilters')}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="bar-concept-bulk">
            <span className="text-sm font-medium text-gray-700">{tk('admin.conceptPicker.inView', { n: String(shown.length) })}</span>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
            <div className="min-w-0 flex-1">
              <RowActions
                align="end"
                menuTestId="menu-concept-bulk"
                actions={[
                  { key: 'show', label: tk('admin.conceptPicker.allVisible', { n: String(shown.length) }), icon: Eye, tone: 'success', disabled: busy || shown.length === 0, onClick: () => setVisible(shownIds, true), testId: 'button-bulk-visible' },
                  { key: 'hide', label: tk('admin.conceptPicker.allHidden', { n: String(shown.length) }), icon: EyeOff, disabled: busy || shown.length === 0, onClick: () => setVisible(shownIds, false), testId: 'button-bulk-hidden' },
                  { key: 'delete', label: tk('admin.conceptPicker.allDelete', { n: String(shown.length) }), icon: Trash2, tone: 'danger', inMenu: true, disabled: busy || shown.length === 0, onClick: () => setConfirmDelete(shownIds), testId: 'button-bulk-delete-shown' },
                ]}
              />
            </div>
          </div>

          {confirmDelete && confirmDelete.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="confirm-bulk-delete">
              <span className="min-w-0 flex-1">{tk('admin.conceptPicker.deleteConfirmMany', { n: String(confirmDelete.length) })}</span>
              <button type="button" onClick={() => remove(confirmDelete)} className="whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700" data-testid="button-confirm-bulk-delete-shown">{t('admin.concepts.yesDelete')}</button>
              <button type="button" onClick={() => setConfirmDelete(null)} className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-gray-700">{t('common.cancelAction')}</button>
            </div>
          )}
          {error && <p className="text-sm text-red-700" data-testid="text-concept-picker-error">{error}</p>}

          <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white" data-testid="list-concept-picker">
            {shown.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500">{t('admin.conceptPicker.noResults')}</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {shown.map((r) => {
                  const c = r.concept;
                  const on = r.visibility === 'visible';
                  const isOpen = expanded === c.id;
                  return (
                    <li key={c.id} className="px-3 py-2" data-testid={`row-concept-${c.id}`}>
                      <ListRow
                        title={onOpenDetails
                          ? <button type="button" className="text-left hover:text-blue-700 hover:underline" onClick={() => onOpenDetails(c.id)}>{c.name}</button>
                          : c.name}
                        badges={<>
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${KIND_BADGE[r.kind]}`}>{tk(`admin.conceptPicker.kind.${r.kind}`)}</span>
                          <span className="flex items-center gap-1 text-[11px] text-gray-500"><span className={`h-2 w-2 rounded-full ${TIER_DOT[r.tier]}`} />{tk(`admin.conceptPicker.tier.${r.tier}`)}</span>
                          {r.docs > 0 && <span className="text-[11px] text-gray-400">{r.docs === 1 ? t('admin.conceptPicker.docsOne') : tk('admin.conceptPicker.docs', { n: String(r.docs) })}</span>}
                          {r.visibility === 'review' && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{t('admin.conceptPicker.status.review')}</span>}
                        </>}
                        meta={c.definition ? (
                          <button type="button" onClick={() => setExpanded(isOpen ? null : c.id)} className={`text-left hover:text-gray-700 ${isOpen ? 'block' : 'line-clamp-1'}`} aria-expanded={isOpen}>
                            {c.definition}
                          </button>
                        ) : undefined}
                        aside={
                          <label className="ml-auto flex shrink-0 items-center gap-2 text-xs text-gray-600">
                            <span className={`whitespace-nowrap ${on ? 'text-accent-700' : r.visibility === 'review' ? 'text-amber-700' : 'text-gray-500'}`}>
                              {tk(`admin.conceptPicker.status.${r.visibility}`)}
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={on}
                              aria-label={tk('admin.conceptPicker.switchLabel', { name: c.name })}
                              disabled={busy}
                              onClick={() => setVisible([c.id], !on)}
                              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-blue-600' : 'bg-gray-300'}`}
                              data-testid={`switch-concept-${c.id}`}
                            >
                              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
                            </button>
                          </label>
                        }
                        actions={[
                          ...(onOpenDetails ? [{ key: 'details', label: t('admin.conceptPicker.details'), icon: Info, onClick: () => onOpenDetails(c.id) }] : []),
                          { key: 'delete', label: t('admin.conceptPicker.delete'), icon: Trash2, tone: 'danger' as const, inMenu: true, disabled: busy, onClick: () => setConfirmDelete([c.id]) },
                        ]}
                        menuTestId={`menu-concept-${c.id}`}
                      >
                        {confirmDelete && confirmDelete.length === 1 && confirmDelete[0] === c.id && (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                            <span className="min-w-0 flex-1">{tk('admin.conceptPicker.deleteConfirmOne', { name: c.name })}</span>
                            <button type="button" onClick={() => remove([c.id])} className="whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700">{t('admin.concepts.yesDelete')}</button>
                            <button type="button" onClick={() => setConfirmDelete(null)} className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-gray-700">{t('common.cancelAction')}</button>
                          </div>
                        )}
                      </ListRow>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
