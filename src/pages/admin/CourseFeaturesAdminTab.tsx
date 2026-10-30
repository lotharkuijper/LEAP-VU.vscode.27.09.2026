import { useState } from 'react';
import { ToggleRight, MessageSquare, Lightbulb, GraduationCap, BarChart3, BookText, Coffee, Loader2, Sigma } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { COURSE_FEATURES, EXPLAIN_PARTS, type CourseFeature, type CourseFeatures, type ExplainPart } from '../../lib/courseFeatures';
import { CourseAttachmentsSetting } from './CourseAttachmentsSetting';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

// Onderdelen per cursus aan/uit (src/lib/courseFeatures.ts, server/courses/courseFeatures.js).
// Elke schakelaar wordt direct opgeslagen; uitzetten verbergt, er wordt niets gewist.

const ICONS: Record<CourseFeature, typeof MessageSquare> = {
  chat: MessageSquare,
  explain: Lightbulb,
  quiz: GraduationCap,
  projects: BarChart3,
  journal: BookText,
  studiecafe: Coffee,
};

/** Gevolgen voor andere onderdelen, alleen getoond als ze nu spelen. */
export function featureConsequences(f: CourseFeatures): TKey[] {
  const out: TKey[] = [];
  if (!f.chat) out.push('courseFeatures.effect.noChat' as TKey);
  if (!f.quiz && f.explain) out.push('courseFeatures.effect.noQuizLink' as TKey);
  if (!f.journal) out.push('courseFeatures.effect.noJournal' as TKey);
  if (!f.journal && f.projects) out.push('courseFeatures.effect.projectsWithoutJournal' as TKey);
  if (!f.studiecafe && (f.chat || f.quiz)) out.push('courseFeatures.effect.noStudiecafe' as TKey);
  return out;
}

export function CourseFeaturesAdminTab() {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  const { session } = useAuth();
  const { activeCourseId, activeCourse, courseFeatures, refreshActiveCourse } = useActiveCourse();
  const [busy, setBusy] = useState<CourseFeature | ExplainPart | 'formulaEditor' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!activeCourseId) {
    return <div className="text-sm text-gray-500" data-testid="text-course-features-no-course">{t('courseFeatures.admin.noCourse')}</div>;
  }

  const toggle = async (f: CourseFeature | ExplainPart | 'formulaEditor') => {
    if (!session?.access_token) return;
    setBusy(f);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${activeCourseId}/features`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ features: { [f]: !courseFeatures[f] } }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      await refreshActiveCourse();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const consequences = featureConsequences(courseFeatures);

  return (
    <div className="space-y-5" data-testid="panel-course-features">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <ToggleRight className="w-5 h-5 text-blue-600" />
          {t('courseFeatures.admin.title')}
          <HelpTip id="courseFeatures.toggles" />
        </h2>
        <AdminHint variant="intro" className="mt-1">
          {t('courseFeatures.admin.intro', { course: activeCourse?.name || '' })}
        </AdminHint>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="text-course-features-error">
          {error}
        </div>
      )}

      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {COURSE_FEATURES.map(f => {
          const Icon = ICONS[f];
          const on = courseFeatures[f];
          return [(
            <li key={f} className="flex items-start gap-3 px-4 py-3" data-testid={`row-feature-${f}`}>
              <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${on ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <label htmlFor={`feature-${f}`} className="block font-medium text-gray-900">{tk(`courseFeatures.name.${f}`)}</label>
                <p className="text-sm text-gray-600">{tk(`courseFeatures.desc.${f}`)}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {busy === f && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
                <span className={`whitespace-nowrap text-xs font-medium ${on ? 'text-accent-700' : 'text-gray-500'}`}>
                  {on ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off')}
                </span>
                <button
                  id={`feature-${f}`}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={tk(`courseFeatures.name.${f}`)}
                  disabled={busy !== null}
                  onClick={() => toggle(f)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-blue-600' : 'bg-gray-300'}`}
                  data-testid={`switch-feature-${f}`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </li>
          ), ...(f === 'explain' && on ? EXPLAIN_PARTS.map(p => {
            const pOn = courseFeatures[p];
            // Minstens één onderdeel van Ik leg uit blijft aan; anders zet je Ik leg uit zelf uit.
            const last = pOn && EXPLAIN_PARTS.filter(x => courseFeatures[x]).length === 1;
            return (
              <li key={p} className="flex items-start gap-3 py-2.5 pl-12 pr-4" data-testid={`row-feature-${p}`}>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`feature-${p}`} className="block text-sm font-medium text-gray-900">{tk(`courseFeatures.name.${p}`)}</label>
                  <p className="text-xs text-gray-600">{tk(`courseFeatures.desc.${p}`)}</p>
                  {last && <p className="text-xs text-gray-500">{t('courseFeatures.admin.explainLastPart')}</p>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {busy === p && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
                  <span className={`whitespace-nowrap text-xs font-medium ${pOn ? 'text-accent-700' : 'text-gray-500'}`}>
                    {pOn ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off')}
                  </span>
                  <button
                    id={`feature-${p}`}
                    type="button"
                    role="switch"
                    aria-checked={pOn}
                    aria-label={tk(`courseFeatures.name.${p}`)}
                    disabled={busy !== null || last}
                    onClick={() => toggle(p)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${pOn ? 'bg-blue-600' : 'bg-gray-300'}`}
                    data-testid={`switch-feature-${p}`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${pOn ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </li>
            );
          }) : [])];
        })}
      </ul>

      {/* Formule-editor (opt-in, 2026-10-22): de ∑-knop bij alle tekstvakken van studenten. */}
      <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3" data-testid="row-feature-formulaEditor">
        <Sigma className={`mt-0.5 h-5 w-5 flex-shrink-0 ${courseFeatures.formulaEditor ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <label htmlFor="feature-formulaEditor" className="flex items-center gap-1.5 font-medium text-gray-900">{t('courseFeatures.name.formulaEditor')}<HelpTip id="courseFeatures.formulaEditor" /></label>
          <p className="text-sm text-gray-600">{t('courseFeatures.desc.formulaEditor')}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {busy === 'formulaEditor' && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
          <span className={`whitespace-nowrap text-xs font-medium ${courseFeatures.formulaEditor ? 'text-accent-700' : 'text-gray-500'}`}>
            {courseFeatures.formulaEditor ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off')}
          </span>
          <button
            id="feature-formulaEditor"
            type="button"
            role="switch"
            aria-checked={courseFeatures.formulaEditor}
            aria-label={t('courseFeatures.name.formulaEditor')}
            disabled={busy !== null}
            onClick={() => toggle('formulaEditor')}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${courseFeatures.formulaEditor ? 'bg-blue-600' : 'bg-gray-300'}`}
            data-testid="switch-feature-formulaEditor"
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${courseFeatures.formulaEditor ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      <CourseAttachmentsSetting
        courseId={activeCourseId}
        courseName={activeCourse?.name || ''}
        on={courseFeatures.attachments}
        token={session?.access_token}
        onChanged={refreshActiveCourse}
      />

      {consequences.length > 0 && (
        <AdminHint variant="warning" testId="course-features-consequences">
          <p className="font-medium">{t('courseFeatures.admin.consequencesTitle')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {consequences.map(k => <li key={k}>{t(k)}</li>)}
          </ul>
        </AdminHint>
      )}

      <AdminHint variant="tip">{t('courseFeatures.admin.keepsData')}</AdminHint>
    </div>
  );
}
