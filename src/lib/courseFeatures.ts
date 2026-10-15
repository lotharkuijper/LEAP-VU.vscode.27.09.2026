// Onderdelen per cursus aan/uit (2026-10-15). Spiegel van server/courseFeatures.js:
// courses.features bewaart alleen wat UIT staat ({ quiz: false }); een
// ontbrekende sleutel betekent aan. Docenten van de cursus en beheerders zien
// een uitgezet onderdeel nog wel, met het label "uit voor studenten".

export const COURSE_FEATURES = ['chat', 'explain', 'quiz', 'projects', 'journal', 'studiecafe'] as const;
export type CourseFeature = (typeof COURSE_FEATURES)[number];
export type CourseFeatures = Record<CourseFeature, boolean>;

export function normalizeCourseFeatures(raw: unknown): CourseFeatures {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as CourseFeatures;
  for (const key of COURSE_FEATURES) out[key] = src[key] !== false;
  return out;
}

/** Bij welk onderdeel hoort een pagina (route)? null = geen schakelaar. */
export const FEATURE_BY_PATH: Record<string, CourseFeature> = {
  '/chat': 'chat',
  '/explain': 'explain',
  '/quiz': 'quiz',
  '/projects': 'projects',
  '/feedback': 'journal',
  '/studiecafe': 'studiecafe',
};

export function featureForPath(pathname: string): CourseFeature | null {
  const first = '/' + (pathname.split('/')[1] || '');
  return FEATURE_BY_PATH[first] ?? null;
}

export interface FeatureView {
  /** Mag deze gebruiker het onderdeel gebruiken/zien? (aan, of staf) */
  visible: boolean;
  /** Staat het onderdeel uit voor studenten (staf ziet het met een label)? */
  offForStudents: boolean;
}

export function featureView(features: CourseFeatures, feature: CourseFeature, isStaff: boolean): FeatureView {
  const on = features[feature] !== false;
  return { visible: on || isStaff, offForStudents: !on };
}
