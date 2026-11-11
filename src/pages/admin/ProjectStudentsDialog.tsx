import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Loader2, Search, Shuffle, Users, X } from 'lucide-react';
import { useLanguage } from '../../i18n';

// Studenten indelen (2026-11-11): de studentenlijst staat niet standaard in beeld,
// maar in deze pop-up. Willekeurig verdelen over groepen van hoogstens de
// maximale groepsgrootte, of zelf een selectie in een groep zetten. Alleen
// studenten van de cursus; de testgroep van een docent is geen doel
// (server/projects/projectGroups.js controleert beide).

export interface DialogPerson { userId: string; name: string | null; email: string | null; student?: boolean }
export interface DialogGroup { id: string; name: string; status: string; teacherGroup?: boolean; members: DialogPerson[] }

const NEW_GROUP = '__new__';
const NO_GROUP = '__none__';

export function ProjectStudentsDialog({ groups, unassigned, maxSize, busy, error, onAuto, onAssign, onClose }: {
  groups: DialogGroup[];
  unassigned: DialogPerson[];
  maxSize: number;
  busy: boolean;
  error: string | null;
  /** Verdeel deze studenten willekeurig over nieuwe groepen van hoogstens `size`. */
  onAuto: (userIds: string[], size: number) => Promise<boolean>;
  /** groupId null = uit de groep halen; newGroup = eerst een nieuwe groep maken. Geeft terug of het lukte. */
  onAssign: (userIds: string[], target: { groupId: string | null } | { newGroup: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [size, setSize] = useState(Math.max(1, maxSize || 4));
  const [query, setQuery] = useState('');
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');

  const label = (p: DialogPerson) => p.name || p.email || '—';
  const active = groups.filter((g) => g.status === 'active');
  const targets = active.filter((g) => !g.teacherGroup);

  // Iedereen die student is, met de groep waar hij nu in zit.
  const rows: Array<DialogPerson & { group: string | null }> = unassigned.map((p) => ({ ...p, group: null }));
  for (const g of active) for (const m of g.members) if (m.student !== false) rows.push({ ...m, group: g.name });
  const everyone = rows.sort((a, b) => label(a).localeCompare(label(b)));

  // Escape sluit het venster.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const shown = everyone.filter((p) => (!onlyUnassigned || p.group === null)
    && (!q || label(p).toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)));
  const allShownSelected = shown.length > 0 && shown.every((p) => selected.has(p.userId));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allShownSelected) shown.forEach((p) => n.delete(p.userId)); else shown.forEach((p) => n.add(p.userId));
    return n;
  });
  const groupsFor = (count: number) => Math.ceil(count / Math.max(1, size));

  const assign = async () => {
    const ids = [...selected];
    if (!ids.length || !target) return;
    const ok = target === NEW_GROUP
      ? await onAssign(ids, { newGroup: newName })
      : await onAssign(ids, { groupId: target === NO_GROUP ? null : target });
    if (!ok) return; // selectie blijft staan, de melding staat bovenaan
    setSelected(new Set());
    setNewName('');
    setTarget('');
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('admin.projects.students.title')} className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl bg-white p-5 shadow-2xl" data-testid="dialog-project-students">
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-blue-600" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-gray-900">{t('admin.projects.students.title')}</h2>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('common.close')} data-testid="button-close-students"><X className="h-5 w-5" /></button>
        </div>
        {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</div>}

        {everyone.length === 0 ? (
          <div className="space-y-3 text-sm text-gray-700" data-testid="students-empty">
            <p>{t('admin.projects.students.none')}</p>
            <Link to="/admin?tab=members" onClick={onClose} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700" data-testid="link-invite-students">
              {t('admin.projects.students.inviteLink')}
            </Link>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* 1. Willekeurig verdelen */}
            <section className="rounded-lg border border-gray-200 p-3" data-testid="section-random">
              <h3 className="text-sm font-medium text-gray-900">{t('admin.projects.students.randomTitle')}</h3>
              {unassigned.length === 0 ? (
                <p className="mt-1 text-xs text-emerald-700">{t('admin.projects.groups.allAssigned')}</p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <label htmlFor="students-size" className="text-xs text-gray-600">{t('admin.projects.students.maxPerGroup')}</label>
                  <input id="students-size" type="number" min={1} max={20} value={size} onChange={(e) => setSize(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} className="w-16 rounded border border-gray-300 px-1.5 py-1 text-sm" data-testid="input-random-size" />
                  <button type="button" disabled={busy} onClick={() => void onAuto(unassigned.map((p) => p.userId), size)}
                    className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-random-groups">
                    <Shuffle className="h-4 w-4" />{t('admin.projects.students.randomBtn', { count: String(unassigned.length), groups: String(groupsFor(unassigned.length)) })}
                  </button>
                </div>
              )}
            </section>

            {/* 2. Zelf indelen */}
            <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-gray-200 p-3" data-testid="section-manual">
              <h3 className="text-sm font-medium text-gray-900">{t('admin.projects.students.manualTitle')}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="relative min-w-0 flex-1 basis-48">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('admin.projects.students.search')} aria-label={t('admin.projects.students.search')}
                    className="w-full rounded border border-gray-300 py-1 pl-7 pr-2 text-sm" data-testid="input-student-search" />
                </span>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} data-testid="check-only-unassigned" />
                  {t('admin.projects.students.onlyUnassigned', { count: String(unassigned.length) })}
                </label>
              </div>

              <div className="mt-2 min-h-[6rem] flex-1 overflow-y-auto rounded border border-gray-100">
                {shown.length === 0 ? (
                  <p className="p-3 text-xs text-gray-500">{t('admin.projects.students.noMatch')}</p>
                ) : (
                  <ul className="divide-y divide-gray-100 text-sm">
                    <li className="flex items-center gap-2 bg-gray-50 px-2 py-1 text-xs text-gray-600">
                      <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label={t('admin.projects.students.selectAll')} data-testid="check-select-all" />
                      <span>{t('admin.projects.students.selectAll')} ({shown.length})</span>
                    </li>
                    {shown.map((p) => (
                      <li key={p.userId}>
                        <label className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-blue-50/50">
                          <input type="checkbox" checked={selected.has(p.userId)} onChange={() => toggle(p.userId)} data-testid={`check-student-${p.userId}`} />
                          <span className="min-w-0 flex-1 truncate">{label(p)}</span>
                          <span className={`flex-shrink-0 text-[11px] ${p.group ? 'text-gray-500' : 'text-amber-700'}`}>{p.group || t('admin.projects.students.noGroup')}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs text-gray-600">{t('admin.projects.students.selected', { count: String(selected.size) })}</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('admin.projects.students.target')} className="rounded border border-gray-300 bg-white px-1.5 py-1 text-sm" data-testid="select-target-group">
                  <option value="">{t('admin.projects.students.target')}</option>
                  {targets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  <option value={NEW_GROUP}>{t('admin.projects.students.newGroup')}</option>
                  <option value={NO_GROUP}>{t('admin.projects.groups.removeFromGroup')}</option>
                </select>
                {target === NEW_GROUP && (
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('admin.projects.groups.newPlaceholder')} aria-label={t('admin.projects.groups.newPlaceholder')} className="w-36 rounded border border-gray-300 px-2 py-1 text-sm" data-testid="input-target-new-group" />
                )}
                <button type="button" disabled={busy || selected.size === 0 || !target} onClick={() => void assign()}
                  className="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40" data-testid="button-assign-selected">
                  {t('admin.projects.students.assignBtn')}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
