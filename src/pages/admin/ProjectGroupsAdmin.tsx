import { useCallback, useEffect, useState } from 'react';
import { Copy, Check, Loader2, Plus, Shuffle, Trash2, Pencil } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { HelpTip } from '../../components/help/HelpTip';
import { Tooltip } from '../../components/help/Tooltip';
import { AdminHint } from '../../components/help/AdminHint';

// Groepen van een project (2026-10-27, server/projects/projectGroups.js). De docent deelt
// in, verplaatst en maakt groepen; bij groepsindeling via Canvas ontstaan de
// groepen vanzelf als studenten het project openen vanuit een Canvas-
// groepsopdracht. Privacy: alleen wie in welke groep zit.

type GroupMode = 'self' | 'teacher' | 'canvas';
interface Person { userId: string; name: string | null; email: string | null }
interface AdminGroup {
  id: string; name: string; status: string; source: GroupMode; external_name: string | null; members: Person[];
}

export function ProjectGroupsAdmin({ projectId, courseId, token }: { projectId: string; courseId: string | null; token: string }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<GroupMode>('self');
  const [groups, setGroups] = useState<AdminGroup[] | null>(null);
  const [unassigned, setUnassigned] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [autoSize, setAutoSize] = useState(4);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [canvasLink, setCanvasLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`/api/projects/${projectId}/group-admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || t('admin.projects.groups.failed'));
    return d;
  }, [projectId, token, t]);

  const load = useCallback(async () => {
    try {
      const d = await call('GET', '');
      setMode(d.groupMode);
      setGroups(d.groups || []);
      setUnassigned(d.unassigned || []);
    } catch (e) {
      setError((e as Error).message);
      setGroups([]);
    }
  }, [call]);
  useEffect(() => { void load(); }, [load]);

  // Canvas: de link voor dit project (als groepsopdracht in Canvas toevoegen).
  useEffect(() => {
    if (mode !== 'canvas' || !courseId) return;
    fetch(`/api/lti/course-link/${courseId}?project=${projectId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setCanvasLink(d?.link || null))
      .catch(() => setCanvasLink(null));
  }, [mode, courseId, projectId, token]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const activeGroups = (groups || []).filter(g => g.status === 'active');
  const label = (p: Person) => p.name || p.email || '—';

  const moveSelect = (p: Person, current: string | null) => (
    <select
      value={current || ''}
      disabled={busy}
      onChange={e => void run(() => call('PUT', `/members/${p.userId}`, { groupId: e.target.value || null }))}
      aria-label={t('admin.projects.groups.moveLabel', { name: label(p) })}
      className="max-w-[10rem] rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px]"
      data-testid={`select-move-${p.userId}`}
    >
      <option value="">{current ? t('admin.projects.groups.removeFromGroup') : t('admin.projects.groups.placeIn')}</option>
      {activeGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );

  return (
    <div className="chic-card p-5" data-testid="card-project-groups">
      <h3 className="font-semibold text-gray-900 flex items-center gap-1.5">
        {t('admin.projects.groups.title', { count: String(groups?.length ?? 0) })}
        <HelpTip id="projects.groupMode" />
      </h3>
      <p className="text-xs text-gray-600" data-testid="text-group-mode">{t(('admin.projects.groupMode.' + mode) as 'admin.projects.groupMode.self')}</p>
      <AdminHint variant="intro" className="mb-3">{t('admin.projects.groups.privacy')}</AdminHint>

      {mode === 'canvas' && (
        <div className="mb-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-xs text-brand-900 space-y-1.5" data-testid="panel-canvas-groups">
          <p>{t('admin.projects.groups.canvasHow')}</p>
          {canvasLink && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 basis-60 truncate rounded bg-white px-2 py-1 text-[11px]" data-testid="text-project-canvas-link">{canvasLink}</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(canvasLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-brand-200 bg-white px-2 py-1 text-[11px]"
                data-testid="button-copy-project-canvas-link"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? t('admin.projects.groups.copied') : t('admin.projects.groups.copyLink')}
              </button>
            </div>
          )}
        </div>
      )}
      {mode === 'self' && <AdminHint variant="tip" className="mb-3">{t('admin.projects.groups.selfHow')}</AdminHint>}

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</div>}

      {/* Groep maken en automatisch verdelen. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex flex-nowrap items-center gap-1">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t('admin.projects.groups.newPlaceholder')}
            aria-label={t('admin.projects.groups.newPlaceholder')}
            className="w-44 rounded border border-gray-300 px-2 py-1 text-sm"
            data-testid="input-new-group"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => { await call('POST', '/groups', { name: newName }); setNewName(''); })}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-blue-600 px-2.5 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="button-new-group"
          >
            <Plus className="w-4 h-4" />{t('admin.projects.groups.newBtn')}
          </button>
        </span>
        {unassigned.length > 1 && (
          <span className="flex flex-nowrap items-center gap-1">
            <label className="text-xs text-gray-600 whitespace-nowrap" htmlFor="auto-size">{t('admin.projects.groups.autoSize')}</label>
            <input id="auto-size" type="number" min={1} max={20} value={autoSize} onChange={e => setAutoSize(Math.max(1, Number(e.target.value) || 4))} className="w-14 rounded border border-gray-300 px-1.5 py-1 text-sm" />
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => call('POST', '/auto', { size: autoSize, userIds: unassigned.map(p => p.userId) }))}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-gray-300 px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
              data-testid="button-auto-groups"
            >
              <Shuffle className="w-4 h-4" />{t('admin.projects.groups.autoBtn', { count: String(unassigned.length) })}
            </button>
          </span>
        )}
        {busy && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
      </div>

      {groups === null ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="text-no-groups">{t('admin.projects.groups.empty')}</p>
      ) : (
        <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))]">
          {groups.map(g => (
            <li key={g.id} className="rounded-lg border border-gray-200 p-3" data-testid={`group-overview-${g.id}`}>
              <div className="flex items-center gap-2">
                {renaming?.id === g.id ? (
                  <form className="flex min-w-0 flex-1 gap-1" onSubmit={e => { e.preventDefault(); void run(async () => { await call('PATCH', `/groups/${g.id}`, { name: renaming.name }); setRenaming(null); }); }}>
                    <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: g.id, name: e.target.value })} className="min-w-0 flex-1 rounded border border-gray-300 px-1.5 py-0.5 text-sm" aria-label={t('admin.projects.groups.renameLabel')} />
                    <button type="submit" className="rounded bg-blue-600 px-2 text-xs text-white">{t('common.save')}</button>
                  </form>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{g.name}</span>
                )}
                {g.source === 'canvas' && <span className="flex-shrink-0 rounded bg-brand-50 px-1.5 text-[10px] text-brand-700">Canvas</span>}
                {g.status === 'finalized' && <span className="flex-shrink-0 text-[10px] text-gray-500">{t('admin.projects.groups.finalized')}</span>}
                {g.status === 'active' && renaming?.id !== g.id && (
                  <Tooltip label={t('admin.projects.groups.renameLabel')}>
                    <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })} className="p-0.5 text-gray-500 hover:bg-gray-100 rounded" data-testid={`button-rename-group-${g.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                  </Tooltip>
                )}
                {g.members.length === 0 && (
                  <Tooltip label={t('admin.projects.groups.deleteEmpty')}>
                    <button type="button" disabled={busy} onClick={() => void run(() => call('DELETE', `/groups/${g.id}`))} className="p-0.5 text-red-500 hover:bg-red-50 rounded" data-testid={`button-delete-group-${g.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  </Tooltip>
                )}
              </div>
              {g.members.length === 0 ? (
                <p className="mt-1 text-xs text-gray-400">{t('admin.projects.groups.noMembers')}</p>
              ) : (
                <ul className="mt-1 space-y-1 text-xs text-gray-700">
                  {g.members.map(m => (
                    <li key={m.userId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{label(m)}</span>
                      {g.status === 'active' && moveSelect(m, g.id)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {unassigned.length > 0 && (
        <div className="mt-4" data-testid="panel-unassigned">
          <p className="text-xs font-medium text-gray-700 mb-1">{t('admin.projects.groups.unassigned', { count: String(unassigned.length) })}</p>
          <ul className="grid gap-1 grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] text-xs text-gray-700">
            {unassigned.map(p => (
              <li key={p.userId} className="flex items-center gap-2 rounded border border-dashed border-gray-200 px-2 py-1">
                <span className="min-w-0 flex-1 truncate">{label(p)}</span>
                {activeGroups.length > 0 && moveSelect(p, null)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
