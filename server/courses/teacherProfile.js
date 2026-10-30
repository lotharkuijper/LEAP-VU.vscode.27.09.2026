import { profileCache } from '../lib/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { profileRoleForCourseTeacher } from './memberRoleAuth.js';

// Wie in een cursus docent wordt, krijgt het profiel 'docent' (memberRoleAuth.js:
// profileRoleForCourseTeacher). Databaseregels voor projecten, opslag en quiz
// kijken naar profiles.role; zonder dit liep een docent met een studentprofiel
// vast op "new row violates row-level security policy" (Rodenburg, 2026-10-16).
// Vastgelegd in user_audit_log. Mislukt dit, dan blijft de cursusrol staan.
export async function promoteCourseTeacherProfile(userId, changedBy, courseId) {
  try {
    const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
    const next = prof ? profileRoleForCourseTeacher(prof.role) : null;
    if (!next) return null;
    const { error } = await supabaseAdmin.from('profiles').update({ role: next }).eq('id', userId).eq('role', prof.role);
    if (error) throw error;
    profileCache.invalidate(userId);
    const { error: logErr } = await supabaseAdmin.from('user_audit_log').insert({
      user_id: userId, changed_by: changedBy || null, old_role: prof.role, new_role: next,
      reason: `Docent in cursus ${courseId} (course_members.member_role = teacher)`,
    });
    if (logErr) console.warn('[members] auditlog schrijven mislukt:', logErr.message);
    console.log(`[members] Profielrol ${userId}: ${prof.role} → ${next} (docent in cursus ${courseId})`);
    return next;
  } catch (err) {
    console.warn('[members] profielrol naar docent mislukt:', err?.message || err);
    return null;
  }
}
