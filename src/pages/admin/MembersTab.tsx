import { useState } from 'react';
import { Users } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { AdminHint } from '../../components/help/AdminHint';
import { CourseMembersPanel } from '../../components/CourseMembersPanel';
import { InviteStudentsForm } from './InviteStudentsForm';

// Openstellen → Leden: wie in de actieve cursus zit en met welke rol, plus studenten
// uitnodigen. Vervangt "Beheer leden" (Cursussen beheren) en "Studenten uitnodigen".
export function MembersTab() {
  const { t } = useLanguage();
  const { activeCourseId, activeCourse, isCourseStaff } = useActiveCourse();
  const [reloadKey, setReloadKey] = useState(0);

  if (!activeCourseId) {
    return <div className="text-sm text-gray-500" data-testid="text-members-no-course">{t('courseFeatures.admin.noCourse')}</div>;
  }

  return (
    <div className="space-y-8" data-testid="tab-members">
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-600" />
            {t('admin.members.title', { course: activeCourse?.name || '' })}
          </h2>
          <AdminHint variant="intro" className="mt-1">{t('admin.members.intro')}</AdminHint>
        </div>
        <CourseMembersPanel
          courseId={activeCourseId}
          courseName={activeCourse?.name || ''}
          canEdit={isCourseStaff}
          reloadKey={reloadKey}
        />
      </section>
      {isCourseStaff && (
        <section className="border-t border-gray-100 pt-6 max-w-3xl">
          <InviteStudentsForm courseId={activeCourseId} onInvited={() => setReloadKey((k) => k + 1)} />
        </section>
      )}
    </div>
  );
}
