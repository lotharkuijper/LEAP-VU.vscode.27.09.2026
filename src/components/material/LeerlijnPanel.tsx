import { useEffect, useMemo, useState } from 'react';
import { ListOrdered, Wand2, Plus, Trash2, X, Loader2, ChevronDown, Save } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../help/AdminHint';
import { HelpTip } from '../help/HelpTip';
import { Tooltip } from '../help/Tooltip';
import { fetchLeerlijn, fetchLeerlijnProposal, saveLeerlijn, type CourseFile } from '../../services/course-files.service';

// Leerlijn: de volgorde van de stof (server/courseUnits.js). Onderdelen met een
// positie; een gelijke positie = naast elkaar. Geen datums: het gaat om de
// opbouw van de stof. De tutorchat verwijst terug naar voorafgaande
// onderdelen en spaarzaam vooruit (behalve naar wat de student al oefende).

interface UnitDraft { key: string; title: string; position: number }

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export function LeerlijnPanel({ courseId, files }: { courseId: string; files: CourseFile[] }) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const material = useMemo(() => files.filter((f) => f.purpose === 'course_material' && !f.isWeb), [files]);
  const [units, setUnits] = useState<UnitDraft[]>([]);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const l = await fetchLeerlijn(courseId);
      setUnits(l.units.map((u) => ({ key: u.id, title: u.title, position: u.position })));
      setAssign(Object.fromEntries(l.documents.map((d) => [d.documentId, d.unitId])));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [courseId]);

  const change = (fn: () => void) => { fn(); setDirty(true); setSaved(false); };
  const sorted = [...units].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const fileById = new Map(material.map((f) => [f.id, f]));
  const unassigned = material.filter((f) => !assign[f.id] || !units.some((u) => u.key === assign[f.id]));

  const propose = async () => {
    setBusy(true); setError(null);
    try {
      const p = await fetchLeerlijnProposal(courseId);
      const next = p.units.map((u, i) => ({ key: `new-${i}-${Date.now()}`, title: u.title, position: u.position }));
      const a: Record<string, string> = {};
      p.units.forEach((u, i) => { for (const d of u.documentIds) a[d] = next[i].key; });
      change(() => { setUnits(next); setAssign(a); });
      setOpen(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await saveLeerlijn(courseId, {
        units: units.map((u) => ({ key: u.key, title: u.title.trim(), position: u.position })),
        assignments: Object.entries(assign).filter(([d, k]) => fileById.has(d) && units.some((u) => u.key === k)).map(([documentId, unitKey]) => ({ documentId, unitKey })),
      });
      await load();
      setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const addUnit = () => change(() => setUnits((prev) => [...prev, { key: `new-${Date.now()}`, title: t('material.leerlijn.newUnit'), position: (prev.reduce((m, u) => Math.max(m, u.position), 0) || 0) + 1 }]));
  const removeUnit = (key: string) => change(() => {
    setUnits((prev) => prev.filter((u) => u.key !== key));
    setAssign((prev) => Object.fromEntries(Object.entries(prev).filter(([, k]) => k !== key)));
  });
  const setUnit = (key: string, patch: Partial<UnitDraft>) => change(() => setUnits((prev) => prev.map((u) => (u.key === key ? { ...u, ...patch } : u))));

  if (material.length === 0) return null;
  const summary = units.length > 0
    ? tk('material.leerlijn.summary', { n: String(units.length), placed: String(material.length - unassigned.length), total: String(material.length) })
    : t('material.leerlijn.none');

  return (
    <section className="rounded-xl border border-gray-200 bg-white" data-testid="panel-leerlijn">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <ListOrdered className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />
        <span className="font-semibold text-gray-900">{t('material.leerlijn.title')}</span>
        <span className="min-w-0 truncate text-sm text-gray-500">{loaded ? summary : ''}</span>
        <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-gray-100 p-4">
          <div className="flex items-start gap-2">
            <AdminHint variant="intro">{t('material.leerlijn.intro')}</AdminHint>
            <HelpTip id="material.leerlijn" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={propose} disabled={busy} className="flex whitespace-nowrap items-center gap-2 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50" data-testid="button-leerlijn-propose">
              <Wand2 className="h-4 w-4" />{t('material.leerlijn.propose')}
            </button>
            <button type="button" onClick={addUnit} disabled={busy} className="flex whitespace-nowrap items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50" data-testid="button-leerlijn-add">
              <Plus className="h-4 w-4" />{t('material.leerlijn.addUnit')}
            </button>
          </div>

          {sorted.length > 0 && (
            <ol className="space-y-2" data-testid="list-leerlijn">
              {sorted.map((u) => {
                const docs = Object.entries(assign).filter(([d, k]) => k === u.key && fileById.has(d)).map(([d]) => fileById.get(d)!);
                const parallel = units.filter((x) => x.position === u.position).length > 1;
                return (
                  <li key={u.key} className="rounded-lg border border-gray-200 p-3" data-testid={`row-unit-${u.key}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-gray-500">
                        {t('material.leerlijn.position')}
                        <input type="number" min={1} value={u.position} onChange={(e) => setUnit(u.key, { position: Math.max(1, Number(e.target.value) || 1) })} className="w-16 rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" aria-label={t('material.leerlijn.position')} />
                      </label>
                      <input value={u.title} maxLength={120} onChange={(e) => setUnit(u.key, { title: e.target.value })} className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm font-medium" aria-label={t('material.leerlijn.unitTitle')} />
                      {parallel && <span className="whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">{t('material.leerlijn.parallel')}</span>}
                      <Tooltip label={t('material.leerlijn.removeUnit')}>
                        <button type="button" onClick={() => removeUnit(u.key)} className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                      </Tooltip>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {docs.length === 0 && <span className="text-xs text-gray-400">{t('material.leerlijn.noFiles')}</span>}
                      {docs.map((f) => (
                        <span key={f.id} className="flex max-w-full items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-2 pr-1 text-xs text-gray-700">
                          <span className="min-w-0 truncate">{f.title}</span>
                          <Tooltip label={t('material.leerlijn.unassign')}>
                            <button type="button" onClick={() => change(() => setAssign((prev) => { const n = { ...prev }; delete n[f.id]; return n; }))} className="shrink-0 rounded-full p-0.5 hover:bg-gray-200"><X className="h-3 w-3" /></button>
                          </Tooltip>
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {sorted.length > 0 && unassigned.length > 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 p-3" data-testid="list-leerlijn-unassigned">
              <p className="text-sm font-medium text-gray-800">{t('material.leerlijn.unassigned')}</p>
              <p className="text-xs text-gray-500">{t('material.leerlijn.unassignedHint')}</p>
              <ul className="mt-2 space-y-1.5">
                {unassigned.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-gray-700">{f.title}</span>
                    <select value="" onChange={(e) => { const k = e.target.value; if (k) change(() => setAssign((prev) => ({ ...prev, [f.id]: k }))); }} className="rounded border border-gray-300 px-2 py-1 text-xs" aria-label={t('material.leerlijn.assignTo')}>
                      <option value="">{t('material.leerlijn.assignTo')}</option>
                      {sorted.map((u) => <option key={u.key} value={u.key}>{u.position}. {u.title}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy || !dirty} className="flex whitespace-nowrap items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-leerlijn-save">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t('common.save')}
            </button>
            {dirty && <span className="text-xs text-amber-700">{t('material.leerlijn.unsaved')}</span>}
            {saved && !dirty && <span className="text-xs text-accent-700" data-testid="text-leerlijn-saved">{t('material.leerlijn.saved')}</span>}
            {error && <span className="text-xs text-red-700">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
