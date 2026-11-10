// Stap 1 van een project inrichten: de opdracht. Wat studenten lezen en waar de
// persona's van uitgaan. De groepsinstellingen staan bij stap 5 (Groepen).
import { useState } from 'react';
import { Save } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { AdminHint } from '../../components/help/AdminHint';

export interface TaskFields {
  title: string;
  research_question: string;
  goals: string | null;
  briefing_markdown: string | null;
  submissions_enabled: boolean | null;
}

/** Wie ziet dit veld? Klein label naast het veld. */
export function Audience({ kind }: { kind: 'students' | 'ai' | 'nobody' }) {
  const { t } = useLanguage();
  const tone = kind === 'students' ? 'bg-green-50 text-green-800' : kind === 'ai' ? 'bg-purple-50 text-purple-800' : 'bg-gray-100 text-gray-600';
  return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>{t(`admin.projects.audience.${kind}` as 'admin.projects.audience.students')}</span>;
}

export function ProjectTaskStep({ project, onSaved, onError, onInfo }: {
  project: TaskFields & { id: string };
  onSaved: (patch: TaskFields) => void;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const { t } = useLanguage();
  const initial = (): TaskFields => ({
    title: project.title || '', research_question: project.research_question || '',
    goals: project.goals || '', briefing_markdown: project.briefing_markdown || '',
    submissions_enabled: !!project.submissions_enabled,
  });
  const [form, setForm] = useState<TaskFields>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  const save = async () => {
    if (!form.title.trim() || !form.research_question.trim()) { onError(t('admin.projects.errorTitleRequired')); return; }
    setSaving(true);
    const patch: TaskFields = {
      title: form.title.trim(), research_question: form.research_question.trim(),
      goals: form.goals || null, briefing_markdown: form.briefing_markdown || null,
      submissions_enabled: !!form.submissions_enabled,
    };
    const { error } = await supabase.from('projects').update(patch as never).eq('id', project.id);
    setSaving(false);
    if (error) { onError(error.message); return; }
    onSaved(patch);
    onInfo(t('admin.projects.task.saved'));
  };

  const input = 'w-full px-3 py-2 border border-gray-300 rounded text-sm';
  return (
    <div className="chic-card p-5 space-y-3" data-testid="section-project-task">
      <div>
        <h3 className="font-semibold text-gray-900">{t('admin.projects.task.title')}</h3>
        <AdminHint variant="intro">{t('admin.projects.task.intro')}</AdminHint>
      </div>
      <div>
        <label htmlFor="pt-title" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldTitle')}<Audience kind="students" /></label>
        <input id="pt-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={input} data-testid="input-project-title" />
      </div>
      <div>
        <label htmlFor="pt-question" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldQuestion')}<Audience kind="students" /><Audience kind="ai" /></label>
        <input id="pt-question" value={form.research_question} onChange={(e) => setForm({ ...form, research_question: e.target.value })} placeholder={t('admin.projects.fieldQuestionPlaceholder')} className={input} data-testid="input-project-question" />
      </div>
      <div>
        <label htmlFor="pt-goals" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldGoals')}<Audience kind="ai" /></label>
        <textarea id="pt-goals" value={form.goals || ''} onChange={(e) => setForm({ ...form, goals: e.target.value })} rows={3} placeholder={t('admin.projects.fieldGoalsPlaceholder')} className={input} data-testid="textarea-project-goals" />
      </div>
      <div>
        <label htmlFor="pt-briefing" className="text-xs font-medium text-gray-700">{t('admin.projects.fieldBriefing')}<Audience kind="students" /></label>
        <textarea id="pt-briefing" value={form.briefing_markdown || ''} onChange={(e) => setForm({ ...form, briefing_markdown: e.target.value })} rows={6} className={`${input} font-mono`} data-testid="textarea-project-briefing" />
      </div>
      <label className="flex items-start gap-2 text-sm border-t border-gray-100 pt-3">
        <input type="checkbox" className="mt-0.5" checked={!!form.submissions_enabled} onChange={(e) => setForm({ ...form, submissions_enabled: e.target.checked })} data-testid="checkbox-project-submissions-enabled" />
        <span>
          <span className="font-medium">{t('admin.projects.subs.enable')}</span>
          <span className="block text-[11px] text-gray-500">{t('admin.projects.subs.enableHint')}</span>
        </span>
      </label>
      <div className="flex justify-end">
        <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-40" data-testid="button-save-project">
          <Save className="w-4 h-4" /> {saving ? t('admin.projects.saving') : t('admin.projects.saveBtn')}
        </button>
      </div>
    </div>
  );
}
