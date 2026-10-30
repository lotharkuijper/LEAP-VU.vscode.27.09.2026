import { requireAuthUser } from '../lib/auth.js';
import { SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';

// Gedeelde toegangscontrole voor de document-viewer-routes (/view én
// /translate): laadt de documentrij en dwingt exact dezelfde folder_permissions-
// regels af als de download-route. Stuurt zelf het foutantwoord en geeft dan
// null terug; bij succes retourneert het { doc, role, isAdmin }.
export async function loadViewableDocument(req, res) {
  const auth = await requireAuthUser(req, res);
  if (!auth) return null;
  const role = auth.profile?.role || 'student';
  const isAdmin = role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
  const { documentId } = req.params;
  try {
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id, updated_at')
      .eq('id', documentId)
      .maybeSingle();
    if (!doc) { res.status(404).json({ error: 'Document niet gevonden.' }); return null; }
    if (doc.bucket && doc.bucket !== 'rag_sources') {
      res.status(403).json({ error: 'Dit document is geen RAG-bron.' }); return null;
    }
    if (!isAdmin) {
      if (!doc.folder_id) { res.status(403).json({ error: 'Geen toegang tot dit document.' }); return null; }
      const { data: perm } = await supabaseAdmin
        .from('folder_permissions')
        .select('can_view')
        .eq('folder_id', doc.folder_id)
        .eq('role', role)
        .maybeSingle();
      if (!perm?.can_view) { res.status(403).json({ error: 'Geen toegang tot dit document.' }); return null; }
    }
    return { doc, role, isAdmin };
  } catch (err) {
    console.error('[viewer-auth] documenttoegang controleren mislukt:', err);
    res.status(500).json({ error: 'Kon documenttoegang niet controleren.' });
    return null;
  }
}
