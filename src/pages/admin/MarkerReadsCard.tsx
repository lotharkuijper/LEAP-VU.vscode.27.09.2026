import { BookOpen, Check, FileText, Gavel } from 'lucide-react';
import { useLanguage } from '../../i18n';

// "Wat leest de nakijkhulp?" (2026-11-11): alles wat de nakijkhulp bij het
// nakijkcommentaar gebruikt, op één plek in stap 4 (ProjectFeedbackSetup).
// Onder de motorkap: project_knowledge_doc_ids (rubric, opdracht, planning) en
// course_knowledge (cursusmateriaal als maatstaf, server/projects/preassessment.js).

export interface MarkerPersona {
  id: string;
  project_knowledge_doc_ids?: string[] | null;
  course_knowledge?: 'none' | 'all' | 'selected' | null;
  course_knowledge_doc_ids?: string[] | null;
}
export interface MarkerDoc { id: string; filename: string; material_kind?: string | null }

type CourseMode = 'none' | 'all' | 'selected';

export function MarkerReadsCard({ marker, docs, onPatch, onChooseFiles }: {
  marker: MarkerPersona;
  docs: MarkerDoc[];
  onPatch: (body: Record<string, unknown>) => void;
  /** Opent de editor van de nakijkhulp om cursusbestanden te kiezen. */
  onChooseFiles: () => void;
}) {
  const { t } = useLanguage();
  const known = marker.project_knowledge_doc_ids || [];
  const rubrics = docs.filter((d) => d.material_kind === 'rubric');
  // Databestanden leest een beoordelaar niet (personaKnowledge.js).
  const others = docs.filter((d) => d.material_kind !== 'rubric' && d.material_kind !== 'data');
  const mode: CourseMode = marker.course_knowledge === 'all' || marker.course_knowledge === 'selected' ? marker.course_knowledge : 'none';
  const chosen = (marker.course_knowledge_doc_ids || []).length;
  const toggleDoc = (id: string) => onPatch({ project_knowledge_doc_ids: known.includes(id) ? known.filter((x) => x !== id) : [...known, id] });

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 space-y-2.5" data-testid="card-marker-reads">
      <h5 className="text-sm font-semibold text-gray-900">{t('admin.projects.fb.reads.title')}</h5>

      <p className="flex items-center gap-1.5 text-xs text-gray-800">
        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />{t('admin.projects.fb.reads.product')}
      </p>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700"><Gavel className="h-3.5 w-3.5" aria-hidden="true" />{t('admin.projects.fb.reads.rubric')}</div>
        {rubrics.length === 0 ? (
          <p className="ml-5 text-xs text-amber-700">{t('admin.projects.fb.noRubricYet')}</p>
        ) : rubrics.map((d) => (
          <label key={d.id} className="ml-5 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={known.includes(d.id)} onChange={() => toggleDoc(d.id)} data-testid={`marker-doc-${d.id}`} />
            <span className="min-w-0 truncate">{d.filename}</span>
          </label>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700"><FileText className="h-3.5 w-3.5" aria-hidden="true" />{t('admin.projects.fb.reads.docs')}</div>
        {others.length === 0 ? (
          <p className="ml-5 text-xs text-gray-500">{t('admin.projects.fb.reads.noDocs')}</p>
        ) : others.map((d) => (
          <label key={d.id} className="ml-5 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={known.includes(d.id)} onChange={() => toggleDoc(d.id)} data-testid={`marker-doc-${d.id}`} />
            <span className="min-w-0 truncate">{d.filename}</span>
          </label>
        ))}
      </div>

      <fieldset className="space-y-1">
        <legend className="flex items-center gap-1.5 text-xs font-medium text-gray-700"><BookOpen className="h-3.5 w-3.5" aria-hidden="true" />{t('admin.projects.fb.reads.course')}</legend>
        <div className="ml-5 flex flex-wrap gap-x-4 gap-y-1 text-xs" role="radiogroup" aria-label={t('admin.projects.fb.reads.course')}>
          {(['none', 'all', 'selected'] as CourseMode[]).map((m) => (
            <label key={m} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <input type="radio" name={`marker-course-${marker.id}`} checked={mode === m}
                onChange={() => onPatch({ course_knowledge: m })} data-testid={`marker-course-${m}`} />
              {t(`admin.projects.fb.reads.course.${m}` as 'admin.projects.fb.reads.course.none')}
            </label>
          ))}
        </div>
        {mode === 'selected' && (
          <p className="ml-5 flex flex-wrap items-center gap-2 text-xs text-gray-700">
            {t('admin.projects.fb.reads.courseSelected', { count: String(chosen) })}
            <button type="button" onClick={onChooseFiles} className="font-medium text-blue-700 hover:underline" data-testid="button-marker-choose-files">{t('admin.projects.fb.reads.chooseFiles')}</button>
          </p>
        )}
        <p className="ml-5 text-[11px] text-gray-600">{t('admin.projects.fb.reads.courseHint')}</p>
      </fieldset>
    </div>
  );
}
