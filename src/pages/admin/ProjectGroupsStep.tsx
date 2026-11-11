// Stap 5 van een project inrichten: groepen. Hoe groepen ontstaan (Canvas,
// docent, studenten zelf), hoe groot ze zijn, en de groepen zelf
// (ProjectGroupsAdmin). Is de cursus nog niet aan Canvas gekoppeld, dan mag de
// docent deze stap overslaan: uitproberen doet hij in zijn eigen testgroep.
import { useState } from 'react';
import { Save } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { HelpTip } from '../../components/help/HelpTip';
import { AdminHint } from '../../components/help/AdminHint';
import { ProjectGroupsAdmin } from './ProjectGroupsAdmin';

export type GroupMode = 'self' | 'teacher' | 'canvas';
export interface GroupFields { group_mode: GroupMode; min_group_size: number; max_group_size: number }

export function ProjectGroupsStep({ project, token, isCanvasCourse, canvasLinked, onSaved, onError, onInfo }: {
  project: GroupFields & { id: string; course_id: string | null };
  token: string;
  /** Loopt de toegang tot de cursus via Canvas? Dan is "Via Canvas" een keuze. */
  isCanvasCourse: boolean;
  /** Is de cursus al eens vanuit Canvas geopend? null = onbekend. */
  canvasLinked: boolean | null;
  onSaved: (patch: GroupFields) => void;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const { t } = useLanguage();
  const initial = (): GroupFields => ({ group_mode: project.group_mode, min_group_size: project.min_group_size, max_group_size: project.max_group_size });
  const [form, setForm] = useState<GroupFields>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());
  const modes = (['canvas', 'teacher', 'self'] as GroupMode[]).filter((m) => m !== 'canvas' || isCanvasCourse || project.group_mode === 'canvas');

  const save = async () => {
    if (form.min_group_size > form.max_group_size) { onError(t('admin.projects.errorMinMax')); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('admin.projects.groups.failed'));
      onSaved(form);
      onInfo(t('admin.projects.task.saved'));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const num = 'w-full px-3 py-2 border border-gray-300 rounded text-sm';
  return (
    <div className="space-y-4">
      <div className="chic-card p-5 space-y-3" data-testid="section-project-group-settings">
        <div>
          <h3 className="font-semibold text-gray-900 flex items-center gap-1.5">{t('admin.projects.groupMode.title')}<HelpTip id="projects.groupMode" /></h3>
          <AdminHint variant="intro">{t('admin.projects.groupsStep.intro')}</AdminHint>
        </div>
        {project.group_mode === 'canvas' && canvasLinked === false && (
          <AdminHint variant="tip" testId="hint-canvas-not-linked">{t('admin.projects.groupsStep.canvasNotLinked')}</AdminHint>
        )}
        <fieldset className="space-y-1" data-testid="fieldset-group-mode">
          <legend className="sr-only">{t('admin.projects.groupMode.title')}</legend>
          {modes.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input type="radio" name="group-mode" className="mt-1" checked={form.group_mode === m}
                onChange={() => setForm({ ...form, group_mode: m })} data-testid={'radio-group-mode-' + m} />
              <span>
                <span className="font-medium">{t(('admin.projects.groupMode.' + m) as 'admin.projects.groupMode.self')}</span>
                <span className="block text-[11px] text-gray-500">{t(('admin.projects.groupMode.' + m + 'Hint') as 'admin.projects.groupMode.selfHint')}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <div>
            <label htmlFor="pg-min" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldMinSize')}</label>
            <input id="pg-min" type="number" min={1} max={20} value={form.min_group_size} onChange={(e) => setForm({ ...form, min_group_size: parseInt(e.target.value) || 1 })} className={num} data-testid="input-project-minsize" />
          </div>
          <div>
            <label htmlFor="pg-max" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldMaxSize')}</label>
            <input id="pg-max" type="number" min={1} max={20} value={form.max_group_size} onChange={(e) => setForm({ ...form, max_group_size: parseInt(e.target.value) || 5 })} className={num} data-testid="input-project-maxsize" />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-40" data-testid="button-save-group-settings">
            <Save className="w-4 h-4" /> {saving ? t('admin.projects.saving') : t('admin.projects.saveBtn')}
          </button>
        </div>
      </div>
      {/* Opnieuw laden na een andere indeling: de kaart leest de indeling zelf. */}
      <ProjectGroupsAdmin key={project.group_mode} projectId={project.id} courseId={project.course_id} token={token} maxSize={project.max_group_size} />
    </div>
  );
}
