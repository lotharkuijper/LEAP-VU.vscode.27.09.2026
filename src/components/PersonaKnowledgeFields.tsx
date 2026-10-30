import { useMemo, useState } from 'react';
import { BookOpen, Eye, EyeOff, FolderOpen, Gavel } from 'lucide-react';
import { useLanguage } from '../i18n';
import { HelpTip } from './help/HelpTip';
import { AdminHint } from './help/AdminHint';

// "Wat kent deze persona?" (2026-10-27, server/projects/personaKnowledge.js). Gedeeld door
// de projecteditor (cursusmateriaal + projectdocumenten) en de sjablooneditor
// (alleen cursusmateriaal: een sjabloon hoort niet bij een project).
// Studenten zien deze keuze niet. Nieuwe persona's kennen niets.

export type CourseKnowledge = 'none' | 'all' | 'selected';

export interface KnowledgeValues {
  course_knowledge?: CourseKnowledge | null;
  course_knowledge_doc_ids?: string[] | null;
  project_knowledge_doc_ids?: string[] | null;
}

export interface KnowledgeCourseDoc { id: string; title: string }
export interface KnowledgeProjectDoc {
  id: string;
  filename: string;
  material_kind: string | null;
  is_visible_to_students: boolean;
  isData: boolean;
  canBeKnowledge: boolean;
}

/** Wat er naar de server gaat. project: false voor sjablonen. */
export function knowledgePayload(v: KnowledgeValues, { project = true }: { project?: boolean } = {}) {
  const mode: CourseKnowledge = v.course_knowledge === 'all' || v.course_knowledge === 'selected' ? v.course_knowledge : 'none';
  return {
    course_knowledge: mode,
    course_knowledge_doc_ids: mode === 'selected' ? (v.course_knowledge_doc_ids || []) : [],
    ...(project ? { project_knowledge_doc_ids: v.project_knowledge_doc_ids || [] } : {}),
  };
}

export function PersonaKnowledgeFields({ value, onChange, courseDocs, projectDocs, isEvaluator = false, idPrefix }: {
  value: KnowledgeValues;
  onChange: (next: KnowledgeValues) => void;
  /** null = nog aan het laden. */
  courseDocs: KnowledgeCourseDoc[] | null;
  /** Weglaten bij een sjabloon. */
  projectDocs?: KnowledgeProjectDoc[] | null;
  isEvaluator?: boolean;
  idPrefix: string;
}) {
  const { t } = useLanguage();
  const [filter, setFilter] = useState('');
  const mode: CourseKnowledge = value.course_knowledge === 'all' || value.course_knowledge === 'selected' ? value.course_knowledge : 'none';
  const courseIds = value.course_knowledge_doc_ids || [];
  const projectIds = value.project_knowledge_doc_ids || [];
  const showProject = projectDocs !== undefined;

  const shownCourseDocs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (courseDocs || []).filter((d) => !q || d.title.toLowerCase().includes(q));
  }, [courseDocs, filter]);

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const projectCount = (projectDocs || []).filter((d) => projectIds.includes(d.id)).length;
  const knowsNothing = (isEvaluator || mode === 'none') && projectCount === 0;
  const summary = knowsNothing
    ? t(isEvaluator ? 'admin.personaKnowledge.summaryNothingEvaluator' : 'admin.personaKnowledge.summaryNothing')
    : t('admin.personaKnowledge.summary', {
        course: isEvaluator ? t('admin.personaKnowledge.courseNone')
          : mode === 'all' ? t('admin.personaKnowledge.courseAllShort')
          : mode === 'selected' ? t('admin.personaKnowledge.courseSelectedShort', { count: String(courseIds.length) })
          : t('admin.personaKnowledge.courseNone'),
        project: String(projectCount),
      });

  return (
    <fieldset className="border-t border-gray-100 pt-3 space-y-3" data-testid={`${idPrefix}-knowledge`}>
      <legend className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
        {t('admin.personaKnowledge.title')}<HelpTip id="personas.knowledge" />
      </legend>
      <AdminHint variant="tip">{t('admin.personaKnowledge.hint')}</AdminHint>

      {!isEvaluator && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />{t('admin.personaKnowledge.courseTitle')}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="radiogroup" aria-label={t('admin.personaKnowledge.courseTitle')}>
            {(['none', 'all', 'selected'] as CourseKnowledge[]).map((m) => (
              <label key={m} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <input
                  type="radio"
                  name={`${idPrefix}-course-knowledge`}
                  checked={mode === m}
                  onChange={() => onChange({ ...value, course_knowledge: m })}
                  data-testid={`${idPrefix}-course-knowledge-${m}`}
                />
                {t(`admin.personaKnowledge.course.${m}` as 'admin.personaKnowledge.course.none')}
              </label>
            ))}
          </div>
          {mode === 'selected' && (
            <div className="rounded-lg border border-gray-200 p-2 space-y-1.5">
              {courseDocs === null ? (
                <p className="text-xs text-gray-500">{t('common.busy')}</p>
              ) : courseDocs.length === 0 ? (
                <p className="text-xs text-gray-500">{t('admin.personaKnowledge.noCourseDocs')}</p>
              ) : (
                <>
                  {courseDocs.length > 8 && (
                    <input
                      type="search"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder={t('admin.personaKnowledge.filterPlaceholder')}
                      aria-label={t('admin.personaKnowledge.filterPlaceholder')}
                      className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                      data-testid={`${idPrefix}-course-doc-filter`}
                    />
                  )}
                  <ul className="max-h-48 overflow-y-auto space-y-0.5">
                    {shownCourseDocs.map((d) => (
                      <li key={d.id}>
                        <label className="flex items-center gap-2 text-xs min-w-0">
                          <input
                            type="checkbox"
                            checked={courseIds.includes(d.id)}
                            onChange={() => onChange({ ...value, course_knowledge_doc_ids: toggle(courseIds, d.id) })}
                            data-testid={`${idPrefix}-course-doc-${d.id}`}
                          />
                          <span className="min-w-0 truncate">{d.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {showProject && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
            {isEvaluator ? <Gavel className="w-3.5 h-3.5" aria-hidden="true" /> : <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />}
            {t(isEvaluator ? 'admin.personaKnowledge.evaluatorTitle' : 'admin.personaKnowledge.projectTitle')}
          </div>
          <p className="text-[11px] text-gray-500">
            {t(isEvaluator ? 'admin.personaKnowledge.evaluatorHint' : 'admin.personaKnowledge.projectHint')}
          </p>
          {projectDocs === null ? (
            <p className="text-xs text-gray-500">{t('common.busy')}</p>
          ) : projectDocs.length === 0 ? (
            <p className="text-xs text-gray-500">{t('admin.personaKnowledge.noProjectDocs')}</p>
          ) : (
            <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100">
              {projectDocs.map((d) => (
                <li key={d.id} className="px-2 py-1.5">
                  <label className={`flex items-center gap-2 text-xs min-w-0 ${d.canBeKnowledge ? '' : 'opacity-60'}`}>
                    <input
                      type="checkbox"
                      checked={d.canBeKnowledge && projectIds.includes(d.id)}
                      disabled={!d.canBeKnowledge}
                      onChange={() => onChange({ ...value, project_knowledge_doc_ids: toggle(projectIds, d.id) })}
                      data-testid={`${idPrefix}-project-doc-${d.id}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{d.filename}</span>
                    {d.material_kind && (
                      <span className="shrink-0 rounded bg-gray-100 px-1.5 text-[10px] text-gray-700">
                        {t(`filePurpose.kind.${d.material_kind}` as 'filePurpose.kind.other')}
                      </span>
                    )}
                    <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-gray-500">
                      {d.is_visible_to_students ? <Eye className="w-3 h-3" aria-hidden="true" /> : <EyeOff className="w-3 h-3" aria-hidden="true" />}
                      {t(d.is_visible_to_students ? 'admin.personaKnowledge.visible' : 'admin.personaKnowledge.hidden')}
                    </span>
                  </label>
                  {!d.canBeKnowledge && (
                    <p className="ml-6 text-[10px] text-gray-500">
                      {t(d.isData ? 'admin.personaKnowledge.isData' : 'admin.personaKnowledge.noText')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className={`text-xs ${knowsNothing ? 'text-amber-800' : 'text-gray-700'}`} data-testid={`${idPrefix}-knowledge-summary`}>
        {summary}
      </p>
    </fieldset>
  );
}
