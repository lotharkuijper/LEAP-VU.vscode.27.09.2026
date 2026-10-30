// Wires the Studiecafé routes (server/studiecafe/studiecafe.js). The e-mail
// digest and the clean-up job live in ./digest.js and are started from index.js.
import { isStaffForCourse, requireAuthUser, userHasCourseAccess } from '../lib/auth.js';
import { courseFeatureOnFor } from '../lib/courseFeatureGate.js';
import { pgPool, supabaseAdmin } from '../lib/supabase.js';
import { registerStudiecafeRoutes } from './studiecafe.js';

export function registerStudiecafe(app) {
  // Studiecafé (Task #304) — per-cursus discussieforum. Alle schrijfacties lopen
  // via de service-role met userHasCourseAccess / isStaffForCourse als poortwachters;
  // SELECT-RLS (sc_can_read_course) spiegelt de zichtbaarheids-gebaseerde toegang.
  registerStudiecafeRoutes(app, {
    supabaseAdmin,
    requireAuthUser,
    // Studiecafé uit in deze cursus (server/courses/courseFeatures.js) = geen toegang,
    // behalve voor de docent en de beheerder.
    userHasCourseAccess: async (user, profile, courseId) =>
      (await userHasCourseAccess(user, profile, courseId))
      && (await courseFeatureOnFor(user, profile, courseId, 'studiecafe')),
    isStaffForCourse,
    pgPool,
  });
}
