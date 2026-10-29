import { userHasCourseAccess } from '../lib/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

// ─── Leerdagboek: cursus-herkomst van notities ───────────────────────────────
// Elke leerdagboek-notitie krijgt een course_id zodat de student ziet binnen
// welke cursus de notitie is aangemaakt. Voor projectflows is projects.course_id
// de autoritatieve bron (courseIdForProject); voor chat/quiz/uitleg geeft de
// frontend de actieve cursus mee. resolveJournalCourseId valideert een
// client-aangeleverde course_id (uuid + bestaat in courses) zodat een ongeldige
// waarde nooit een FK-fout veroorzaakt die het opslaan van de notitie blokkeert.
const JOURNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveJournalCourseId(courseId, user = null) {
  if (!courseId || typeof courseId !== 'string' || !JOURNAL_UUID_RE.test(courseId)) return null;
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('courses').select('id').eq('id', courseId).maybeSingle();
    if (!data?.id) return null;
    // Alleen een cursus die de student ook echt mag gebruiken (geen labels
    // van andermans cursus op je dagboek).
    if (user && !(await userHasCourseAccess(user, null, data.id))) return null;
    return data.id;
  } catch { return null; }
}
