import { loadLeerlijn } from '../courses/courseUnits.js';
import { supabaseAdmin } from './supabase.js';

// ── Leerlijn (server/courseUnits.js) ─────────────────────────────────────────
// Leerlijn per cursus 30 s en geoefende onderdelen per student 2 min onthouden:
// de tutorchat vraagt ze bij elke beurt op. Een storing laat de chat gewoon
// doorgaan zonder leerlijnblok.
const LEERLIJN_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;

export const leerlijnCache = new Map();

export async function cachedLeerlijn(courseId) {
  const hit = leerlijnCache.get(courseId);
  if (hit && Date.now() - hit.at < LEERLIJN_TTL_MS) return hit.value;
  const value = await loadLeerlijn(supabaseAdmin, courseId);
  leerlijnCache.set(courseId, { at: Date.now(), value });
  return value;
}

/** Leerstofbestanden van een cursus (voor het voorstel en de controle bij opslaan). */
export async function courseMaterialDocuments(courseId) {
  const { data: assigns } = await supabaseAdmin.from('course_folder_assignments').select('folder_id').eq('course_id', courseId);
  const folderIds = (assigns || []).map((a) => a.folder_id);
  if (folderIds.length === 0) return [];
  const { data: docs } = await supabaseAdmin.from('documents')
    .select('id, title, filename, purpose, bucket').in('folder_id', folderIds);
  return (docs || []).filter((d) => d.purpose === 'course_material' || (d.purpose == null && d.bucket === 'rag_sources'));
}

/** Schakelaar-logboek (migratie 20261016100000); ontbrekende tabel = niet loggen. */
export async function logSettingChange({ courseId = null, setting, value, changedBy }) {
  try {
    await supabaseAdmin.from('leap_setting_changes').insert({ course_id: courseId, setting, value, changed_by: changedBy || null });
  } catch (err) {
    console.warn('[settings-log] schrijven mislukt:', err?.message || err);
  }
}

// Toegestane RAG-folder-ids voor een cursus. Geeft `[]` terug als de cursus
// geen folders gekoppeld heeft — searchChunksServerSide retourneert dan geen
// resultaten. Geeft NOOIT `null` terug; null betekent "alle folders" en
// veroorzaakt een cross-course leak.
export async function courseRagFolderIds(courseId) {
  if (!courseId) return [];
  const { data: assignments } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('folder_id')
    .eq('course_id', courseId);
  const assignedFolderIds = (assignments || []).map(a => a.folder_id);
  if (assignedFolderIds.length === 0) return [];
  const { data: ragFolders } = await supabaseAdmin
    .from('document_folders')
    .select('id')
    .in('id', assignedFolderIds)
    .eq('folder_type', 'rag_sources');
  return (ragFolders || []).map(f => f.id);
}
