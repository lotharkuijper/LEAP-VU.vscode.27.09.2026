// "Feedback en beoordeling" in een project (besluit 2026-11-10): drie stappen in
// de volgorde waarin een student ze meemaakt, met per stap wie wat ziet.
//   1. Wat telt: de rubric (openbaar) en de criteria in het kort.
//   2. Feedback tijdens het project: beoordelaars met een maximum aantal rondes;
//      zuiver formatief, alleen de groep ziet het.
//   3. Nakijkcommentaar voor de docent: één beoordelaar leest het eindproduct.
// Onder de motorkap blijven het gewone beoordelaar-persona's en projectdocumenten
// (docs/decisions/projecten.md); dit blok laat de docent in doelen denken.
import { useState } from 'react';
import { Eye, EyeOff, FileText, Loader2, Paperclip, Pencil, Plus, Save, Scale, Trash2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { AdminHint } from '../../components/help/AdminHint';
import { PersonaAvatar } from '../../components/PersonaAvatar';
import { Tooltip } from '../../components/help/Tooltip';
import { HelpTip } from '../../components/help/HelpTip';
import type { AvatarConfig } from '../../lib/personaAvatar';

export interface FeedbackPersona {
  id: string;
  name: string;
  avatar_emoji: string;
  avatar?: AvatarConfig | null;
  persona_type?: string;
  deliverable_label?: string | null;
  max_reviews?: number | null;
  project_knowledge_doc_ids?: string[] | null;
}
export interface FeedbackDoc {
  id: string;
  filename: string;
  material_kind?: string | null;
  is_visible_to_students: boolean;
}

/** Criteria uit het projectformulier (oud: strings, nieuw: { title }). */
export function criteriaLines(raw: unknown): string {
  return (Array.isArray(raw) ? raw : [])
    .map((c) => (typeof c === 'string' ? c : (c as { title?: string; name?: string })?.title || (c as { name?: string })?.name || ''))
    .filter(Boolean).join('\n');
}

function Step({ n, title, who, children, testId }: { n: number; title: string; who: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">{n}</span>
        <h4 className="font-medium text-gray-900 text-sm">{title}</h4>
        <span className="text-[11px] text-gray-500">{who}</span>
      </div>
      {children}
    </section>
  );
}

export function ProjectFeedbackSetup({
  project, token, personas, docs, accept, preassessorId, onPreassessorChange,
  onToggleDocVisibility, onUploadRubric, uploading, onNewEvaluator, onPersonasChanged, onEditPersona, onDeletePersona, onError, onInfo,
}: {
  project: { id: string; rubric_criteria: unknown; submissions_enabled: boolean | null };
  token: string;
  personas: FeedbackPersona[];
  docs: FeedbackDoc[];
  /** Bestandstypen voor de rubric-upload. */
  accept: string;
  preassessorId: string | null;
  onPreassessorChange: (id: string | null) => void;
  onToggleDocVisibility: (doc: FeedbackDoc) => void;
  /** Uploadt een projectdocument als zichtbare rubric. */
  onUploadRubric: (file: File) => void;
  uploading: boolean;
  /** Opent de persona-editor met een beoordelaar die de rubric al kent. */
  onNewEvaluator: (purpose: 'feedback' | 'marking') => void;
  onPersonasChanged: () => void;
  onEditPersona: (p: FeedbackPersona) => void;
  onDeletePersona: (p: FeedbackPersona) => void;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const { t } = useLanguage();
  const rubrics = docs.filter((d) => d.material_kind === 'rubric');
  const rubricIds = rubrics.map((d) => d.id);
  const evaluators = personas.filter((p) => p.persona_type === 'evaluator');
  const feedbackGivers = evaluators.filter((p) => p.id !== preassessorId);
  const marker = evaluators.find((p) => p.id === preassessorId) || null;
  const knowsRubric = (p: FeedbackPersona) => rubricIds.length > 0 && (p.project_knowledge_doc_ids || []).some((id) => rubricIds.includes(id));

  const [criteria, setCriteria] = useState(() => criteriaLines(project.rubric_criteria));
  const [savedCriteria, setSavedCriteria] = useState(criteria);
  const [savingCriteria, setSavingCriteria] = useState(false);
  const saveCriteria = async () => {
    setSavingCriteria(true);
    const list = criteria.split('\n').map((s) => s.trim()).filter(Boolean).map((title) => ({ title }));
    const { error } = await supabase.from('projects').update({ rubric_criteria: list } as never).eq('id', project.id);
    setSavingCriteria(false);
    if (error) { onError(error.message); return; }
    setSavedCriteria(criteria);
    onInfo(t('admin.projects.fb.criteriaSaved'));
  };

  const patchPersona = async (p: FeedbackPersona, body: Record<string, unknown>) => {
    const r = await fetch(`/api/projects/${project.id}/personas/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { onError(d.error || t('admin.projects.personas.saveFailed')); return; }
    onPersonasChanged();
  };
  // Nakijkhulp aanwijzen of loslaten (null: de bot wordt weer feedbackgever, stap 2).
  const setMarker = async (personaId: string | null) => {
    const r = await fetch(`/api/projects/${project.id}/preassessment-persona`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ personaId }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { onError(d.error || t('admin.projects.personas.saveFailed')); return; }
    onPreassessorChange(personaId);
  };
  const linkRubric = (p: FeedbackPersona) =>
    patchPersona(p, { project_knowledge_doc_ids: [...new Set([...(p.project_knowledge_doc_ids || []), ...rubricIds])] });

  const evaluatorRow = (p: FeedbackPersona, withRounds: boolean) => (
    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5" data-testid={`fb-evaluator-${p.id}`}>
      <PersonaAvatar avatar={p.avatar} name={p.name} size={24} />
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-sm text-gray-900">{p.name}</div>
        {p.deliverable_label && <div className="text-[11px] text-gray-500">{t('room.feedback.about', { product: p.deliverable_label })}</div>}
      </div>
      {withRounds && (
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          {t('admin.projects.fb.rounds')}
          <input
            type="number" min={1} max={50}
            defaultValue={p.max_reviews ?? ''}
            placeholder={t('admin.personaRole.evaluator.unlimited')}
            onBlur={(e) => {
              const v = e.target.value.trim();
              const next = v === '' ? null : Math.max(1, Math.min(50, Math.floor(Number(v))));
              if (next !== (p.max_reviews ?? null)) void patchPersona(p, { max_reviews: next });
            }}
            className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
            data-testid={`input-fb-rounds-${p.id}`}
          />
        </label>
      )}
      {knowsRubric(p) ? (
        <span className="text-[11px] text-green-700">{t('admin.projects.fb.knowsRubric')}</span>
      ) : rubricIds.length > 0 ? (
        <button type="button" onClick={() => void linkRubric(p)} className="text-[11px] font-medium text-blue-700 hover:underline" data-testid={`button-fb-link-rubric-${p.id}`}>
          {t('admin.projects.fb.linkRubric')}
        </button>
      ) : (
        <span className="text-[11px] text-amber-700">{t('admin.projects.fb.noRubricYet')}</span>
      )}
      <span className="flex items-center gap-0.5">
        <Tooltip label={t('admin.projects.personas.editBtn')}>
          <button type="button" onClick={() => onEditPersona(p)} className="p-1 rounded text-gray-600 hover:bg-gray-100" data-testid={`button-fb-edit-${p.id}`}><Pencil className="w-3.5 h-3.5" /></button>
        </Tooltip>
        <Tooltip label={t('admin.projects.personas.deleteTitle')}>
          <button type="button" onClick={() => onDeletePersona(p)} className="p-1 rounded text-red-500 hover:bg-red-50" data-testid={`button-fb-delete-${p.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
        </Tooltip>
      </span>
    </li>
  );

  return (
    <div className="chic-card p-5 space-y-3" data-testid="section-feedback-setup">
      <div>
        <h3 className="font-semibold text-gray-900 flex items-center gap-2"><Scale className="w-4 h-4" /> {t('admin.projects.fb.title')}</h3>
        <AdminHint variant="intro">{t('admin.projects.fb.intro')}</AdminHint>
      </div>

      <Step n={1} title={t('admin.projects.fb.step1')} who={t('admin.projects.fb.step1Who')} testId="fb-step-criteria">
        {rubrics.length === 0 ? (
          <p className="text-xs text-gray-600">{t('admin.projects.fb.noRubric')}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rubrics.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid={`fb-rubric-${d.id}`}>
                <FileText className="w-4 h-4 text-gray-500" />
                <span className="min-w-0 flex-1 truncate text-sm">{d.filename}</span>
                {!d.is_visible_to_students && <span className="text-[11px] text-amber-700">{t('admin.projects.fb.rubricHidden')}</span>}
                <button
                  type="button"
                  onClick={() => onToggleDocVisibility(d)}
                  className={`p-1 rounded ${d.is_visible_to_students ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}`}
                  aria-label={d.is_visible_to_students ? t('admin.projects.docs.visibleTitle') : t('admin.projects.docs.hiddenTitle')}
                  data-testid={`button-fb-rubric-visibility-${d.id}`}
                >
                  {d.is_visible_to_students ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs cursor-pointer ${uploading ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          {t('admin.projects.fb.uploadRubric')}
          <input type="file" accept={accept} className="hidden" disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUploadRubric(f); }}
            data-testid="input-fb-upload-rubric" />
        </label>
        <div>
          <label htmlFor="fb-criteria" className="text-xs font-medium text-gray-700">{t('admin.projects.fb.criteriaLabel')}</label>
          <textarea id="fb-criteria" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3}
            placeholder={t('admin.projects.rubricPlaceholder')}
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm" data-testid="textarea-fb-criteria" />
          {criteria !== savedCriteria && (
            <button type="button" onClick={() => void saveCriteria()} disabled={savingCriteria}
              className="mt-1 inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white rounded text-xs disabled:opacity-40" data-testid="button-fb-save-criteria">
              <Save className="w-3.5 h-3.5" /> {t('admin.projects.saveBtn')}
            </button>
          )}
        </div>
      </Step>

      <Step n={2} title={t('admin.projects.fb.step2')} who={t('admin.projects.fb.step2Who')} testId="fb-step-feedback">
        <p className="text-xs text-gray-600">{t('admin.projects.fb.step2Desc')}</p>
        {feedbackGivers.length === 0
          ? <p className="text-xs text-gray-500" data-testid="text-fb-feedback-off">{t('admin.projects.fb.feedbackOff')}</p>
          : <ul className="divide-y divide-gray-100">{feedbackGivers.map((p) => evaluatorRow(p, true))}</ul>}
        <button type="button" onClick={() => onNewEvaluator('feedback')}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline" data-testid="button-fb-add-feedback">
          <Plus className="w-3.5 h-3.5" /> {t('admin.projects.fb.addFeedback')}
        </button>
      </Step>

      <Step n={3} title={t('admin.projects.fb.step3')} who={t('admin.projects.fb.step3Who')} testId="fb-step-marking">
        {!project.submissions_enabled ? (
          <AdminHint variant="tip">{t('admin.projects.fb.needSubmissions')}</AdminHint>
        ) : marker ? (
          // Een vaste nakijkhulp: geen keuzelijst met feedbackgevers (die haalde
          // een feedbackgever stilletjes weg uit stap 2). Uitzetten = verwijderen.
          <>
            <p className="text-xs text-gray-600">{t('admin.projects.fb.step3Desc')} <HelpTip id="projects.preassessment" /></p>
            <ul data-testid="fb-marker">{evaluatorRow(marker, false)}</ul>
            <button type="button" onClick={() => void setMarker(null)}
              className="text-[11px] text-gray-600 hover:underline" data-testid="button-fb-marker-to-feedback">
              {t('admin.projects.fb.markerToFeedback')}
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-600" data-testid="text-fb-marking-none">{t('admin.projects.fb.markingNone')} <HelpTip id="projects.preassessment" /></p>
            <button type="button" onClick={() => onNewEvaluator('marking')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline" data-testid="button-fb-add-marking">
              <Plus className="w-3.5 h-3.5" /> {t('admin.projects.fb.addMarking')}
            </button>
          </>
        )}
      </Step>

      <p className="text-sm font-medium text-gray-800" data-testid="text-fb-you-assess">{t('admin.projects.fb.youAssess')}</p>
    </div>
  );
}
