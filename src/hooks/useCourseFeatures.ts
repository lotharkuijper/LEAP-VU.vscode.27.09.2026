import { useMemo } from 'react';
import { useOptionalActiveCourse } from '../contexts/ActiveCourseContext';
import { featureView, normalizeCourseFeatures, type CourseFeature, type FeatureView } from '../lib/courseFeatures';

const ALL_ON = normalizeCourseFeatures(null);

/**
 * Onderdelen van de actieve cursus (src/lib/courseFeatures.ts).
 * `visible(f)`: tonen (aan, of de gebruiker is docent/beheerder);
 * `offForStudents(f)`: uitgezet — staf ziet het met een label.
 */
export function useCourseFeatures() {
  // Buiten de provider (of met een gedeeltelijke context, zoals in tests): alles aan.
  const ctx = useOptionalActiveCourse();
  const courseFeatures = ctx?.courseFeatures ?? ALL_ON;
  const isCourseStaff = !!ctx?.isCourseStaff;
  return useMemo(() => {
    const view = (f: CourseFeature): FeatureView => featureView(courseFeatures, f, isCourseStaff);
    return {
      features: courseFeatures,
      isStaff: isCourseStaff,
      view,
      visible: (f: CourseFeature) => view(f).visible,
      offForStudents: (f: CourseFeature) => view(f).offForStudents,
    };
  }, [courseFeatures, isCourseStaff]);
}
