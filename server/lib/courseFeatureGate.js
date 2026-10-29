import { FEATURE_DISABLED_MSG, featureAllowed, normalizeCourseFeatures } from '../courses/courseFeatures.js';
import { isStaffForCourse, loadProfileRoleEmail, profileCache } from './auth.js';
import { supabaseAdmin } from './supabase.js';

// ── Onderdelen per cursus (server/courseFeatures.js) ─────────────────────────
// De schakelaars worden bij veel aanroepen gelezen; kort onthouden (15 s) en bij
// een wijziging direct vergeten. Ontbrekende kolom of leesfout = alles aan
// (een storing mag een cursus niet stilleggen).
const COURSE_FEATURES_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 15_000;

export const courseFeaturesCache = new Map();

export async function loadCourseFeatures(courseId) {
  if (!courseId || !supabaseAdmin) return normalizeCourseFeatures(null);
  const hit = courseFeaturesCache.get(courseId);
  if (hit && Date.now() - hit.at < COURSE_FEATURES_TTL_MS) return hit.features;
  try {
    const { data, error } = await supabaseAdmin.from('courses').select('features').eq('id', courseId).maybeSingle();
    const features = normalizeCourseFeatures(error ? null : data?.features);
    if (!error) courseFeaturesCache.set(courseId, { at: Date.now(), features });
    return features;
  } catch {
    return normalizeCourseFeatures(null);
  }
}

// Mag deze gebruiker dit onderdeel in deze cursus gebruiken? Docent van de
// cursus en beheerder altijd (voorbereiden en testen). Zonder cursus: ja.
export async function courseFeatureOnFor(user, profile, courseId, feature) {
  if (!courseId) return true;
  const features = await loadCourseFeatures(courseId);
  if (features[feature] !== false) return true;
  let prof = profile;
  if (!prof && user?.id) prof = (await profileCache.get(user.id, loadProfileRoleEmail))?.data || null;
  return featureAllowed({ features, feature, isStaff: await isStaffForCourse(user, prof, courseId) });
}

// Stuurt 403 en geeft true terug als het onderdeel voor deze gebruiker uit staat.
export async function rejectIfFeatureOff(res, user, profile, courseId, feature) {
  if (await courseFeatureOnFor(user, profile, courseId, feature)) return false;
  res.status(403).json({ error: FEATURE_DISABLED_MSG, code: 'feature_disabled', feature });
  return true;
}
