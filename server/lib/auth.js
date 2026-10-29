import { createClient } from '@supabase/supabase-js';
import { createProfileCache, createUserCache } from './authCache.js';
import { canAccessCourseContent } from '../courses/courseAvailability.js';
import { coursesHasStudentVisible } from './schemaFlags.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, supabaseAdmin } from './supabase.js';

// Inlogcontrole en profiel kort onthouden (server/authCache.js): scheelt per
// verzoek een rondgang naar de inlogserver en een profielvraag. In tests uit.
const AUTH_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : Number(process.env.LEAP_AUTH_CACHE_MS ?? 30000);

export const userCache = createUserCache({ ttlMs: AUTH_CACHE_TTL_MS });

export const profileCache = createProfileCache({ ttlMs: AUTH_CACHE_TTL_MS });

export const loadProfileRoleEmail = (id) => supabaseAdmin.from('profiles').select('role, email').eq('id', id).maybeSingle();

// ── Documenten: toegang (beheer) ────────────────────────────────────────────

export async function resolveAdminUser(req) {
  const auth = await authUser(req);
  if (auth.error) return { error: auth.error };
  const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
  if (!profile) return { error: { status: 403, body: { error: 'Profiel niet gevonden' } } };
  const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
  // Task #165: 'docent' is geen globale rol meer. Voor backward-compat
  // betekent isDocent nu "deze user is in minstens één cursus docent".
  // Per-endpoint moeten extra controles op de specifieke cursus gebeuren
  // (via isStaffForCourse / isCourseTeacher).
  const isDocent = !isAdmin && await userIsTeacherAnywhere(auth.user.id);
  return { user: auth.user, profile, isAdmin, isDocent };
}

// Per-cursus ItemBank-bronconfiguratie (Task #334, stap 5).
// GET ?courseId= → de effectieve bron voor de cursus (eigen override of globale
// terugval). PUT { courseId, repositoryUrl, lastSyncedAt? } → schrijf de
// override. DELETE /:courseId → verwijder de override (terug naar globaal).
// Zonder courseId betreft het de GLOBALE bron en geldt admin-only. Alle
// schrijfacties lopen via service-role met een per-cursus docentcheck, zodat
// docenten niet langer rechtstreeks naar de admin-only chatbot_prompts-tabel
// hoeven te schrijven (wat voorheen faalde).
export function isAdminAuth(auth) {
  return auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
}

// Helper: vereis een geauthenticeerde gebruiker (alle rollen). Wordt gebruikt
// door endpoints die ook studenten mogen aanroepen — combineer met
// `userHasCourseAccess()` zodra de route per cursus filtert om cross-course
// dataleks te voorkomen.
export async function requireAuthUser(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Admin client niet beschikbaar' });
    return null;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header vereist' });
    return null;
  }
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
    if (error || !user) {
      res.status(401).json({ error: 'Niet geauthenticeerd' });
      return null;
    }
    const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);
    return { user, profile: profile || { role: 'student' } };
  } catch (err) {
    res.status(401).json({ error: 'Authenticatie mislukt: ' + err.message });
    return null;
  }
}

// ── Per-cursus rollen (Task #165) ───────────────────────────────────────────
// 'docent' is geen globale rol meer. Iemand is docent IN een cursus als
// course_members.member_role = 'teacher' voor die cursus. Admin/superuser
// blijft overal staff.

export async function isCourseTeacher(userId, courseId) {
  if (!userId || !courseId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .eq('member_role', 'teacher')
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

export async function isStaffForCourse(user, profile, courseId) {
  if (!user) return false;
  if (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL) return true;
  return isCourseTeacher(user.id, courseId);
}

export async function userIsTeacherAnywhere(userId) {
  if (!userId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('member_role', 'teacher')
      .limit(1);
    return !!(data && data.length);
  } catch { return false; }
}

export async function isStaffAnywhere(user, profile) {
  if (!user) return false;
  if (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL) return true;
  return userIsTeacherAnywhere(user.id);
}

// Controleer of een gebruiker toegang heeft tot de inhoud van een cursus.
// Centrale regel via canAccessCourseContent: admins altijd; verborgen cursussen
// alléén voor de docent; verder alleen voor leden en docenten (toegangsroute,
// 2026-10-20; spiegelt de courses-RLS). Geen cursus = geen toegang.
export async function userHasCourseAccess(user, profile, courseId) {
  if (!courseId || !user) return false;
  const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
  if (isAdmin) return true;
  try {
    // Laad de cursus-status eerst. Toegang = lidmaatschap of docentschap
    // (toegangsroute per cursus, server/enrollment.js; spiegelt de courses-RLS).
    const courseCols = coursesHasStudentVisible ? 'is_active, student_visible' : 'is_active';
    const { data: course, error: courseErr } = await supabaseAdmin
      .from('courses')
      .select(courseCols)
      .eq('id', courseId)
      .maybeSingle();
    if (courseErr) {
      // 42703 = student_visible-kolom ontbreekt toch → behandel als zichtbaar en
      // lees enkel is_active opnieuw. Andere leesfouten: fail-closed.
      if (courseErr.code === '42703' || /student_visible/.test(courseErr.message || '')) {
        const { data: c2 } = await supabaseAdmin
          .from('courses').select('is_active').eq('id', courseId).maybeSingle();
        if (!c2) return false;
        if (c2.is_active !== false) return true;
        const isMember = await userHasCourseMembership(user.id, courseId);
        const teacher = isMember ? false : await isCourseTeacher(user.id, courseId);
        return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember, isActive: false, studentVisible: true });
      }
      return false;
    }
    if (!course) return false;
    const isActive = course.is_active !== false;
    const studentVisible = coursesHasStudentVisible ? (course.student_visible !== false) : true;
    // Verborgen cursus: alléén docent (geen membership-lookup nodig).
    if (!studentVisible) {
      const teacher = await isCourseTeacher(user.id, courseId);
      return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember: false, isActive, studentVisible: false });
    }
    // Zichtbaar (actief of gearchiveerd): lid óf docent.
    const isMember = await userHasCourseMembership(user.id, courseId);
    const teacher = isMember ? false : await isCourseTeacher(user.id, courseId);
    return canAccessCourseContent({ isAdmin: false, isCourseTeacher: teacher, isMember, isActive: false, studentVisible: true });
  } catch {
    return false;
  }
}

// Helper: heeft de gebruiker een course_members-rij in deze cursus?
async function userHasCourseMembership(userId, courseId) {
  if (!userId || !courseId || !supabaseAdmin) return false;
  try {
    const { data } = await supabaseAdmin
      .from('course_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

// Helper: vereis admin/docent. Geeft op fout een response en `null` terug.
export async function requireAdminOrDocent(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Admin client niet beschikbaar' });
    return null;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header vereist' });
    return null;
  }
  try {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
    if (error || !user) {
      res.status(401).json({ error: 'Niet geauthenticeerd' });
      return null;
    }
    const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);
    const isSuperuser = profile?.email === SUPERUSER_EMAIL;
    // Toegestaan voor superuser/admin, of voor wie in minstens één cursus
    // docent is. Per-cursus checks volgen in de aanroepende endpoint.
    const isAdminLocal = isSuperuser || profile?.role === 'admin';
    if (!profile || (!isAdminLocal && !(await userIsTeacherAnywhere(user.id)))) {
      res.status(403).json({ error: 'Geen toegang' });
      return null;
    }
    return { user, profile, role: isAdminLocal ? 'admin' : 'teacher' };
  } catch (err) {
    res.status(401).json({ error: 'Authenticatie mislukt: ' + err.message });
    return null;
  }
}

// =============================================================================
// Task #78: Projectruimte MVP — endpoints
// =============================================================================

// Helper: identificeer de huidige user via Authorization-header.
export async function authUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return { error: { status: 401, body: { error: 'Authorization header vereist' } } };
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
  if (error || !user) return { error: { status: 401, body: { error: 'Niet geauthenticeerd' } } };
  return { user };
}

// Helper: alleen admin/superuser óf een docent die lid is van de cursus
// waar het project onder valt. Voor docenten zónder course-lidmaatschap
// (= een andere cursus) is het project niet bewerkbaar.
// Privacy (2026-10-08): de INHOUD van een projectgroep (chat, gesprekken met
// persona's, logboek, feedback, verstandhouding, bestanden van de groep) is
// alleen voor de leden van die groep en voor beheerders van LEAP — niet voor
// docenten. Docenten zien wel wie er in welke groep zit (groups-overview).
export function isLeapAdmin(profile) {
  return !!profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
}
