import { useEffect, useState } from 'react';
import { Archive, BookText, DoorOpen, Eye, EyeOff, Link2, Loader2, Pencil, School } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { useCourseAccess } from '../../contexts/CourseAccessContext';
import { supabase } from '../../lib/supabase';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { ListRow, StatusBadge } from '../../components/ui/ListRow';
import type { RowAction } from '../../components/ui/RowActions';
import { CanvasLinkDialog } from '../../components/CanvasLinkDialog';
import { CourseEditionDialog } from '../../components/CourseEditionDialog';
import { CourseInfoDialog } from '../../components/CourseInfoDialog';
import { EnrollmentModeDialog } from '../../components/EnrollmentModeDialog';
import type { EnrollmentMode } from '../../services/enrollment.service';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

// Openstellen → Cursus: hoe de actieve cursus voor studenten openstaat. De docent regelt
// hier beschikbaarheid, cursus-info, de Canvas-link en een nieuwe editie; de toegangsroute
// ziet hij, maar alleen de beheerder wijzigt hem (server/courses/enrollment.js).

// Eén instelling als lijstrij (ListRow, zoals elders in Beheer): pictogram + titel met
// eventueel een HelpTip, een status, een toelichting en de knoppen.
function SettingRow({ icon: Icon, title, help, badge, actions = [], children, testId }: {
  icon: typeof Eye; title: string; help?: ComponentProps<typeof HelpTip>['id'];
  badge?: ReactNode; actions?: RowAction[]; children: ReactNode; testId: string;
}) {
  return (
    <li className="border border-gray-200 rounded-md px-4 py-3 bg-white">
      <ListRow
        testId={testId}
        title={
          <span className="flex flex-nowrap items-center gap-1.5">
            <Icon className="h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden />
            {title}
            {help && <HelpTip id={help} />}
          </span>
        }
        badges={badge}
        meta={children}
        actions={actions}
      />
    </li>
  );
}

export function CourseTab() {
  const { t } = useLanguage();
  const { session, isAdmin, user } = useAuth();
  const { activeCourseId, activeCourse, isCourseStaff } = useActiveCourse();
  const { refreshCourses } = useCourseAccess();
  const [course, setCourse] = useState<{ student_visible: boolean; enrollment_mode: EnrollmentMode } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'info' | 'canvas' | 'edition' | 'enrollment' | null>(null);

  async function load(courseId: string) {
    const { data, error: err } = await supabase
      .from('courses').select('student_visible, enrollment_mode').eq('id', courseId).maybeSingle();
    if (err) { setError(err.message); return; }
    const row = data as { student_visible?: boolean; enrollment_mode?: EnrollmentMode } | null;
    setCourse({ student_visible: row?.student_visible !== false, enrollment_mode: row?.enrollment_mode || 'open' });
  }

  useEffect(() => {
    setCourse(null);
    setError(null);
    setDialog(null);
    if (activeCourseId) void load(activeCourseId);
  }, [activeCourseId]);

  if (!activeCourseId) {
    return <div className="text-sm text-gray-500" data-testid="text-course-no-course">{t('courseFeatures.admin.noCourse')}</div>;
  }
  const courseName = activeCourse?.name || '';

  async function toggleAvailability() {
    if (!course || !session?.access_token || !activeCourseId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${activeCourseId}/availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ student_visible: !course.student_visible }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t('coursesAdmin.errors.changeFailed', { status: String(res.status) }));
      setCourse({ ...course, student_visible: !course.student_visible });
      await refreshCourses();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const isCanvas = course?.enrollment_mode === 'canvas' || course?.enrollment_mode === 'canvas_open';

  return (
    <div className="space-y-5" data-testid="tab-course">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <School className="w-5 h-5 text-blue-600" />
          {t('admin.course.title', { course: courseName })}
        </h2>
        <AdminHint variant="intro" className="mt-1">{t('admin.course.intro')}</AdminHint>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="text-course-error">{error}</div>
      )}

      {!course ? (
        <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
      ) : (
        <ul className="space-y-2">
          <SettingRow
            icon={course.student_visible ? Eye : EyeOff}
            title={t('admin.course.availability')}
            testId="row-course-availability"
            badge={
              <StatusBadge tone={course.student_visible ? 'success' : 'warning'} testId="status-course-visible">
                {course.student_visible ? t('coursesAdmin.row.available') : t('coursesAdmin.row.unavailable')}
              </StatusBadge>
            }
            actions={isCourseStaff ? [{
              key: 'availability',
              label: course.student_visible ? t('coursesAdmin.row.makeUnavailable') : t('coursesAdmin.row.makeAvailable'),
              icon: course.student_visible ? EyeOff : Eye,
              tone: course.student_visible ? 'warning' : 'success',
              onClick: toggleAvailability, busy, testId: 'button-toggle-availability',
            }] : []}
          >
            {course.student_visible ? t('coursesAdmin.row.visibleTitle') : t('coursesAdmin.row.hiddenTitle')}
          </SettingRow>

          <SettingRow
            icon={DoorOpen}
            title={t('admin.course.access')}
            help="courses.enrollmentMode"
            testId="row-course-access"
            badge={
              <StatusBadge tone={course.enrollment_mode === 'closed' ? 'neutral' : 'info'} testId="status-course-enrollment">
                {t(`enrollment.mode.${course.enrollment_mode}` as TKey)}
              </StatusBadge>
            }
            actions={[
              ...(isCanvas && isCourseStaff ? [{
                key: 'canvas', label: t('canvasLink.action'), icon: Link2, tone: 'primary' as const,
                title: t('canvasLink.actionTitle'), onClick: () => setDialog('canvas'), testId: 'button-canvas-link',
              }] : []),
              ...(isAdmin ? [{
                key: 'enrollment', label: t('coursesAdmin.row.edit'), icon: Pencil, tone: 'primary' as const,
                title: t('enrollment.actionTitle'), onClick: () => setDialog('enrollment'), testId: 'button-enrollment-mode',
              }] : []),
            ]}
          >
            {t(`enrollment.modeDesc.${course.enrollment_mode}` as TKey)}
            {!isAdmin && <> {t('enrollment.setByAdmin')}</>}
          </SettingRow>

          {isCourseStaff && (
            <SettingRow
              icon={BookText}
              title={t('admin.tabs.courseInfo')}
              testId="row-course-info"
              actions={[{
                key: 'info', label: t('coursesAdmin.row.edit'), icon: Pencil, tone: 'primary',
                onClick: () => setDialog('info'), testId: 'button-course-info',
              }]}
            >
              {t('coursesAdmin.row.courseInfoTitle')}
            </SettingRow>
          )}

          {isCourseStaff && (
            <SettingRow
              icon={Archive}
              title={t('editions.action')}
              help="courses.edition"
              testId="row-course-edition"
              actions={[{
                key: 'edition', label: t('admin.course.editionStart'), icon: Archive, tone: 'primary',
                onClick: () => setDialog('edition'), testId: 'button-course-edition',
              }]}
            >
              {t('editions.actionTitle')}
            </SettingRow>
          )}
        </ul>
      )}

      {dialog === 'info' && <CourseInfoDialog courseId={activeCourseId} courseName={courseName} onClose={() => setDialog(null)} />}
      {dialog === 'edition' && (
        <CourseEditionDialog courseId={activeCourseId} courseName={courseName} currentUserId={user?.id || null} onClose={() => setDialog(null)} />
      )}
      {dialog === 'canvas' && <CanvasLinkDialog courseId={activeCourseId} courseName={courseName} isAdmin={isAdmin} onClose={() => setDialog(null)} />}
      {dialog === 'enrollment' && course && (
        <EnrollmentModeDialog
          courseId={activeCourseId}
          courseName={courseName}
          current={course.enrollment_mode}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); void load(activeCourseId); }}
        />
      )}
    </div>
  );
}
