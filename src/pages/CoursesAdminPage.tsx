import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useCourseAccess } from '../contexts/CourseAccessContext';

// Sinds 2026-11-02 bestaat de losse pagina "Cursussen beheren" niet meer. Oude links
// (bladwijzers, handleiding) gaan naar de nieuwe plek in Beheer:
//   ?manageMembers=<id> → Openstellen → Leden, ?courseInfo=<id> → Openstellen → Cursus
//   (met die cursus als actieve cursus, alleen als het een eigen cursus is of je beheerder
//   bent); anders Beheerder → Cursussen of, voor een docent, Openstellen → Cursus.
export function CoursesAdminPage() {
  const { isAdmin } = useAuth();
  const { setActiveCourse } = useActiveCourse();
  const { courses, loadingCourses } = useCourseAccess();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || (loadingCourses && !isAdmin)) return;
    done.current = true;
    const members = searchParams.get('manageMembers');
    const info = searchParams.get('courseInfo');
    const courseId = members || info;
    const tab = members ? 'members' : info ? 'course' : isAdmin ? 'courses' : 'course';
    const mayActivate = !!courseId && (isAdmin || courses.some((c) => c.id === courseId));
    (async () => {
      if (mayActivate) {
        try { await setActiveCourse(courseId!); } catch { /* de server bepaalt toch wat je mag zien */ }
      }
      navigate(`/admin?tab=${tab}`, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingCourses, isAdmin]);

  return (
    <div className="flex justify-center py-12 text-gray-500">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}
