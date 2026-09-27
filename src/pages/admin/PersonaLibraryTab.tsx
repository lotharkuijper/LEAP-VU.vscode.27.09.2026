import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { Bot, FolderOpen, Trash2, Pencil, Plus, Save, X, Download, Check, ArrowRight, Loader2 } from 'lucide-react';

/** Per sjabloon: de titels van de projecten die er een kopie van hebben. */
export function usageBySource(
  copies: Array<{ source_persona_id: string | null; project_id: string }>,
  projects: Array<{ id: string; title: string }>,
): Map<string, string[]> {
  const titles = new Map(projects.map(p => [p.id, p.title]));
  const out = new Map<string, string[]>();
  for (const c of copies) {
    if (!c.source_persona_id || !titles.has(c.project_id)) continue;
    const list = out.get(c.source_persona_id) || [];
    const title = titles.get(c.project_id)!;
    if (!list.includes(title)) list.push(title);
    out.set(c.source_persona_id, list);
  }
  return out;
}

interface CoursePersona {
  id: string;
  course_id: string;
  name: string;
  avatar_emoji: string;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  is_default: boolean;
  persona_type?: string | null;
}

interface ProjectOption {
  id: string;
  title: string;
}

const EMPTY_FORM = {
  name: '',
  avatar_emoji: '🤖',
  system_prompt: '',
  rag_enabled: true,
  persona_type: 'conversational' as string,
};

export function PersonaLibraryTab({ onOpenProjects }: {
  /** Naar het tabblad Projecten (bv. als de cursus nog geen projecten heeft). */
  onOpenProjects?: () => void;
} = {}) {
  const { isAdmin, isDocent, session } = useAuth();
  // Docenten beheren de sjablonen van hun eigen cursus; de server controleert
  // per cursus (isStaffForCourse).
  const canEdit = isAdmin || isDocent;
  const { activeCourseId, activeCourse } = useActiveCourse();
  const { t } = useLanguage();
  const [personas, setPersonas] = useState<CoursePersona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<typeof EMPTY_FORM & { id?: string }>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [fetchTarget, setFetchTarget] = useState<CoursePersona | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [usage, setUsage] = useState<Map<string, string[]>>(new Map());
  const [copies, setCopies] = useState<Array<{ source_persona_id: string | null; project_id: string }>>([]);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [savedNew, setSavedNew] = useState<CoursePersona | null>(null);

  const load = useCallback(async () => {
    if (!activeCourseId) { setPersonas([]); return; }
    const { data, error: e } = await supabase
      .from('course_personas')
      .select('*')
      .eq('course_id', activeCourseId)
      .order('is_default', { ascending: false });
    if (e) setError(e.message); else setPersonas((data as any) || []);
  }, [activeCourseId]);

  useEffect(() => { load(); }, [load]);

  // "Gebruikt in": kopieën in de projecten van deze cursus onthouden hun
  // herkomst (project_personas.source_persona_id, geen FK).
  const loadUsage = useCallback(async () => {
    if (!activeCourseId) { setUsage(new Map()); setCopies([]); return; }
    const { data: projs } = await supabase.from('projects').select('id, title').eq('course_id', activeCourseId).order('created_at', { ascending: false });
    setProjects((projs as any) || []);
    const ids = (projs || []).map((p: { id: string }) => p.id);
    if (!ids.length) { setUsage(new Map()); setCopies([]); return; }
    const { data: rows } = await supabase.from('project_personas').select('source_persona_id, project_id').in('project_id', ids);
    setCopies((rows as any) || []);
    setUsage(usageBySource((rows as any) || [], (projs as any) || []));
  }, [activeCourseId]);

  useEffect(() => { loadUsage(); }, [loadUsage, personas]);

  const authHeader = (): Record<string, string> =>
    session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};

  const removePersona = async (p: CoursePersona) => {
    const confirmed = window.confirm(
      t('admin.personaLib.removeConfirm', { name: p.name })
    );
    if (!confirmed) return;
    setDeleting(p.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/course-personas/${p.id}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || t('admin.personaLib.err.deleteFailed'));
      } else {
        await load();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const startEdit = (p: CoursePersona) => {
    setForm({
      id: p.id,
      name: p.name,
      avatar_emoji: p.avatar_emoji,
      system_prompt: p.system_prompt,
      rag_enabled: p.rag_enabled,
      persona_type: p.persona_type || 'conversational',
    });
    setEditingId(p.id);
    setError(null);
  };

  const startNew = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId('new');
    setError(null);
  };

  const cancelEdit = () => { setEditingId(null); setError(null); };

  const savePersona = async () => {
    if (!form.name.trim()) { setError(t('admin.personaLib.err.nameRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === 'new';
      const url = isNew ? '/api/admin/course-personas' : `/api/admin/course-personas/${editingId}`;
      const body = isNew ? { course_id: activeCourseId, ...form } : form;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || t('admin.personaLib.err.saveFailed'));
      } else {
        setEditingId(null);
        // Na een NIEUW sjabloon meteen de logische vervolgstap aanbieden.
        setSavedNew(isNew && d.persona ? d.persona : null);
        await load();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openFetchModal = (p: CoursePersona) => {
    setFetchTarget(p);
    setFetchMsg(null);
    setError(null);
    setSavedNew(null);
    loadUsage();
  };

  const closeFetchModal = () => { setFetchTarget(null); setFetchMsg(null); };

  // Projecten waarin dit sjabloon al een kopie heeft.
  const projectsWith = (templateId: string) =>
    new Set(copies.filter(c => c.source_persona_id === templateId).map(c => c.project_id));

  const addToProject = async (projectId: string, projectTitle: string) => {
    if (!fetchTarget) return;
    setAddingTo(projectId);
    setFetchMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/personas/from-library/${fetchTarget.id}`, {
        method: 'POST',
        headers: { ...authHeader() },
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFetchMsg({ ok: false, text: d.error || t('admin.personaLib.err.addFailed') });
      } else {
        setFetchMsg({ ok: true, text: t('admin.personaLib.addedToProject', { name: fetchTarget.name, project: projectTitle }) });
        await loadUsage();
      }
    } catch (err: any) {
      setFetchMsg({ ok: false, text: err.message });
    } finally {
      setAddingTo(null);
    }
  };

  if (!activeCourseId) {
    return (
      <div className="p-8 text-center text-gray-500 chic-card">
        {t('admin.personaLib.selectCourse')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="chic-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Bot className="w-5 h-5" /> {t('admin.personaLib.title')}</h2>
            <p className="text-sm text-gray-500 max-w-3xl">
              {t('admin.personaLib.intro', { course: activeCourse?.name || '' })}
            </p>
          </div>
          {canEdit && (
            <button
              onClick={startNew}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-lg"
              data-testid="button-new-cp"
            >
              <Plus className="w-4 h-4" />{t('admin.personaLib.newTemplate')}
            </button>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-100 text-blue-800 px-3 py-2 rounded text-xs flex items-start gap-2 mb-3">
          <FolderOpen className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{t('admin.personaLib.copyHint')}</span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>
        )}

        {savedNew && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-3 py-2 rounded text-sm mb-3 flex flex-wrap items-center gap-2" data-testid="notice-cp-saved">
            <Check className="w-4 h-4" />
            <span className="flex-1">{t('admin.personaLib.savedNext', { name: savedNew.name })}</span>
            <button onClick={() => openFetchModal(savedNew)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-800" data-testid="button-saved-add-to-project">
              {t('admin.personaLib.addToProjectBtn')}<ArrowRight className="w-3 h-3" />
            </button>
            <button onClick={() => setSavedNew(null)} className="p-1 rounded hover:bg-green-100" aria-label={t('common.close')}><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">{t('admin.personaLib.empty')}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {personas.map(p => (
              <li key={p.id} className="py-3 flex items-start gap-3" data-testid={`persona-row-${p.id}`}>
                <span className="text-2xl">{p.avatar_emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {p.name}
                    {p.persona_type === 'evaluator' && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.evaluator')}</span>}
                    {p.is_default && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.default')}</span>}
                    {!p.rag_enabled && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{t('admin.personaLib.badge.ragOff')}</span>}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{p.system_prompt.slice(0, 200)}</p>
                  <p className="text-[11px] text-gray-500 mt-1" data-testid={`text-cp-usage-${p.id}`}>
                    {usage.get(p.id)?.length
                      ? t('admin.personaLib.usedIn', { projects: usage.get(p.id)!.join(', ') })
                      : t('admin.personaLib.notUsed')}
                  </p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => openFetchModal(p)}
                    className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded flex items-center gap-1"
                    data-testid={`button-fetch-cp-${p.id}`}
                  >
                    <Download className="w-3 h-3" />
                    {t('admin.personaLib.addToProjectBtn')}
                  </button>
                  {canEdit && (
                    <>
                      <button
                        onClick={() => startEdit(p)}
                        className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded"
                        title={t('common.edit')}
                        data-testid={`button-edit-cp-${p.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removePersona(p)}
                        disabled={deleting === p.id}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-40"
                        title={t('admin.personaLib.removeFromLibrary')}
                        data-testid={`button-delete-cp-${p.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editingId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">
                {editingId === 'new'
                  ? t('admin.personaLib.modalNewTitle')
                  : t('admin.personaLib.modalEditTitle')}
              </h3>
              <button onClick={cancelEdit} className="p-1 hover:bg-gray-100 rounded" data-testid="button-cancel-cp">
                <X className="w-4 h-4" />
              </button>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3">{error}</div>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-700">{t('admin.personaLib.nameLabel')}</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    data-testid="input-cp-name"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Emoji</label>
                  <input
                    value={form.avatar_emoji}
                    onChange={e => setForm({ ...form, avatar_emoji: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    data-testid="input-cp-emoji"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">Type</label>
                <select
                  value={form.persona_type}
                  onChange={e => setForm({ ...form, persona_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                  data-testid="select-cp-type"
                >
                  <option value="conversational">{t('admin.personaLib.typeConversational')}</option>
                  <option value="evaluator">{t('admin.personaLib.typeEvaluator')}</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">System prompt</label>
                <textarea
                  value={form.system_prompt}
                  onChange={e => setForm({ ...form, system_prompt: e.target.value })}
                  rows={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono"
                  data-testid="textarea-cp-prompt"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.rag_enabled}
                  onChange={e => setForm({ ...form, rag_enabled: e.target.checked })}
                  data-testid="checkbox-cp-rag"
                />
                RAG aan (gebruikt cursusmateriaal)
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={cancelEdit} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">
                {t('admin.personaLib.cancel')}
              </button>
              <button
                onClick={savePersona}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40"
                data-testid="button-save-cp"
              >
                <Save className="w-4 h-4" />
                {saving ? t('admin.personaLib.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {fetchTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="dialog-add-to-project">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">
                {t('admin.personaLib.addToProjectTitle', { name: fetchTarget.name })}
              </h3>
              <button onClick={closeFetchModal} className="p-1 hover:bg-gray-100 rounded" data-testid="button-close-fetch">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              {t('admin.personaLib.fetchDesc', { name: fetchTarget.name })}
            </p>
            {fetchMsg && (
              <div className={`px-3 py-2 rounded text-sm mb-3 ${fetchMsg.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-700'}`} data-testid="text-add-to-project-msg">
                {fetchMsg.text}
              </div>
            )}
            {projects.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 space-y-2" data-testid="empty-add-to-project">
                <p>{t('admin.personaLib.noProjects')}</p>
                {onOpenProjects && (
                  <button onClick={() => { closeFetchModal(); onOpenProjects(); }} className="inline-flex items-center gap-1 text-blue-700 font-medium hover:underline" data-testid="button-go-to-projects">
                    {t('admin.personaLib.goToProjects')}<ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-72 overflow-y-auto">
                {projects.map(pr => {
                  const already = projectsWith(fetchTarget.id).has(pr.id);
                  return (
                    <li key={pr.id} className="px-3 py-2 flex items-center gap-3" data-testid={`row-add-to-project-${pr.id}`}>
                      <span className="flex-1 text-sm text-gray-900">{pr.title}</span>
                      {already && (
                        <span className="inline-flex items-center gap-1 text-xs text-green-700"><Check className="w-3.5 h-3.5" />{t('admin.personaLib.alreadyAdded')}</span>
                      )}
                      <button
                        onClick={() => addToProject(pr.id, pr.title)}
                        disabled={addingTo !== null}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded disabled:opacity-40 ${already ? 'text-gray-600 border border-gray-200 hover:bg-gray-50' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                        data-testid={`button-add-to-project-${pr.id}`}
                      >
                        {addingTo === pr.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        {already ? t('admin.personaLib.addAnotherCopy') : t('admin.personaLib.addBtn')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex justify-end mt-4">
              <button onClick={closeFetchModal} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PersonaLibraryTab;
