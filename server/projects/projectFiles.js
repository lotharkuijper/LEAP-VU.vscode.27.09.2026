import { pgPool, supabaseAdmin } from '../lib/supabase.js';
import { BINARY_DOWNLOAD_EXT_RE, MAX_DOC_CHARS, extractTextFromUpload } from '../lib/uploads.js';

// Zoek of maak de cursus-Projectdata-map aan en geef het id terug.
// Structuur: [cursusmap] → Projectdata → [projectnaam] → bestanden
// courseId en uploadedById zijn verplicht; parentCourseId mag null zijn.
async function findOrCreateCourseProjectdataFolder(courseId, uploadedById) {
  if (!pgPool) return null;
  try {
    // Zoek een bestaande "Projectdata"-map die al gekoppeld is aan DEZE cursus
    // via course_folder_assignments (!inner join = alleen mappen mét koppeling).
    const { data: existingRows } = await supabaseAdmin
      .from('document_folders')
      .select('id, course_folder_assignments!inner(course_id)')
      .eq('name', 'Projectdata')
      .eq('course_folder_assignments.course_id', courseId)
      .limit(1);
    const existingId = existingRows?.[0]?.id;
    if (existingId) return existingId;

    // Geen map voor deze cursus — zoek de parent-cursusmap van DEZE cursus
    // (folder_type 'course' of 'general', gekoppeld via course_folder_assignments).
    const { data: courseAssigned } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id, document_folders!inner(id, folder_type)')
      .eq('course_id', courseId);
    const courseParent = (courseAssigned || []).find(
      a => a.document_folders?.folder_type === 'course' || a.document_folders?.folder_type === 'general'
    );
    let parentId = courseParent?.folder_id || null;

    // Geen cursusmap gevonden via assignments — weiger de aanmaak in plaats van
    // een zwevende map onder de globale root te creëren. Elke cursus moet een
    // expliciete course_folder_assignment hebben met een map van folder_type='course'.
    // Zie migratie 20260511130000 voor het opzetten van de correcte structuur.
    if (!parentId) {
      console.error(`[projectdata-folder] Cursus ${courseId} heeft geen cursusmap (folder_type='course') via course_folder_assignments. Stel de mapstructuur in via de admin-UI vóórdat projecten bestanden uploaden.`);
      return null;
    }

    // Subtree-fallback: als er al een "Projectdata"-map bestaat als direct kind
    // van de gevonden parent-map (maar zonder assignment-rij), gebruik die dan
    // en voeg alsnog de assignment toe — zo voorkomen we dubbele mappen.
    if (parentId) {
      const { data: subtreeRows } = await supabaseAdmin
        .from('document_folders')
        .select('id')
        .eq('name', 'Projectdata')
        .eq('parent_folder_id', parentId)
        .limit(1);
      const subtreeId = subtreeRows?.[0]?.id;
      if (subtreeId) {
        await supabaseAdmin.from('course_folder_assignments').upsert(
          { course_id: courseId, folder_id: subtreeId },
          { onConflict: 'course_id,folder_id', ignoreDuplicates: true }
        );
        console.log(`[projectdata-folder] Hergebruikt via subtree: ${subtreeId} voor cursus ${courseId}`);
        return subtreeId;
      }
    }

    const result = await pgPool.query(
      `INSERT INTO document_folders (name, description, parent_folder_id, created_by, folder_type, is_root)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['Projectdata', 'Projectdata — bestanden per project', parentId, uploadedById, 'data', false]
    );
    const folderId = result.rows[0]?.id;
    if (!folderId) return null;

    await pgPool.query(
      `INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
       VALUES ($1,'admin',true,true),($1,'docent',true,true),($1,'student',true,false)
       ON CONFLICT DO NOTHING`,
      [folderId]
    );
    await supabaseAdmin.from('course_folder_assignments').upsert(
      { course_id: courseId, folder_id: folderId },
      { onConflict: 'course_id,folder_id', ignoreDuplicates: true }
    );
    console.log(`[projectdata-folder] Projectdata aangemaakt: ${folderId} voor cursus ${courseId}`);
    return folderId;
  } catch (e) {
    console.error('[projectdata-folder] fout bij Projectdata-map:', e.message);
    return null;
  }
}

// Zoek of maak een per-project submap aan binnen de Projectdata-map.
// Geeft het subfolder-id terug (of null bij fout).
async function findOrCreateProjectSubfolder(projectId, projectTitle, uploadedById) {
  if (!pgPool) return null;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    if (!project?.course_id) return null;

    const projectdataId = await findOrCreateCourseProjectdataFolder(project.course_id, uploadedById);
    if (!projectdataId) return null;

    const safeName = String(projectTitle || '').slice(0, 200).trim() || projectId.slice(0, 36);

    // Zoek bestaande submap strikt op projectId in de description.
    // Fallback op naam alleen als de description-markering nog niet bestaat
    // (bijv. mappen aangemaakt vóór dit schema).
    const { data: existingSubs } = await supabaseAdmin
      .from('document_folders')
      .select('id, name, description')
      .eq('parent_folder_id', projectdataId);
    const byProjectId = (existingSubs || []).find(
      f => f.description && f.description.includes(`projectId:${projectId}`)
    );
    if (byProjectId?.id) return byProjectId.id;

    // Aanmaken via pg zodat RLS geen invloed heeft.
    // Sla projectId op in description zodat we later deterministisch kunnen opzoeken.
    const result = await pgPool.query(
      `INSERT INTO document_folders (name, description, parent_folder_id, created_by, folder_type, is_root)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [safeName, `Projectbestanden — projectId:${projectId}`, projectdataId, uploadedById, 'data', false]
    );
    const subfolderId = result.rows[0]?.id;
    if (!subfolderId) return null;

    await pgPool.query(
      `INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
       VALUES ($1,'admin',true,true),($1,'docent',true,true),($1,'student',true,false)
       ON CONFLICT DO NOTHING`,
      [subfolderId]
    );
    console.log(`[projectdata-folder] Projectsubmap aangemaakt: ${subfolderId} ("${safeName}")`);
    return subfolderId;
  } catch (e) {
    console.error('[projectdata-folder] fout bij projectsubmap:', e.message);
    return null;
  }
}

// Kern van het uploaden van een projectdocument, los van HTTP, zodat ook het
// cursusmateriaal-beheer (doel "Projectmateriaal", server/courseFiles.js) een
// bestand exact op dezelfde manier aan een project kan toevoegen. De aanroeper
// controleert zelf de staff-rechten (requireProjectStaff).
// Gooit { status, message } bij een gebruikersfout.
export async function createProjectDocumentFromBuffer({ projectId, projectTitle, userId, filename, buffer, mimeType, size, materialKind }) {
  const isBinaryDownload = BINARY_DOWNLOAD_EXT_RE.test(filename);
  let text = null;
  if (!isBinaryDownload) {
    try { text = await extractTextFromUpload({ buffer, originalname: filename, mimetype: mimeType, size }); }
    catch (e) { throw { status: 400, message: e.message || 'Kon tekst niet uit bestand halen' }; }
    if (!text || text.length === 0) throw { status: 400, message: 'Geen leesbare tekst gevonden in dit bestand' };
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + `

…[afgekapt op ${MAX_DOC_CHARS.toLocaleString('nl-NL')} tekens]`;
    }
  }

  let documentRefId = null;

  if (isBinaryDownload) {
    // Binaire bestanden worden in de `documents`-tabel opgeslagen zodat ze
    // zichtbaar zijn in de cursusboom. We gebruiken de directe pg-verbinding
    // zodat de bytea-kolom correct wordt gevuld (PostgREST snapt geen raw
    // Buffer via JSON).
    if (!pgPool) throw { status: 503, message: 'Directe DB-verbinding niet beschikbaar' };

    const folderId = await findOrCreateProjectSubfolder(projectId, projectTitle, userId);
    const mime = mimeType || 'application/octet-stream';
    const safeFilename = String(filename).slice(0, 200);

    const docResult = await pgPool.query(
      `INSERT INTO documents
         (title, filename, file_path, file_type, file_size, folder_id,
          uploaded_by, processing_status, total_chunks, file_bytes, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', 0, $8, $9)
       RETURNING id`,
      [
        safeFilename,
        safeFilename,
        '',                          // lege placeholder (file_path heeft default '')
        mime,
        size || 0,
        folderId,                    // null is ok als map niet aangemaakt kon worden
        userId,
        buffer,                      // pg stuurt Buffer direct als bytea
        mime,
      ]
    );
    documentRefId = docResult.rows[0]?.id;
    if (!documentRefId) throw { status: 500, message: 'Kon bestandsrecord niet aanmaken' };
  } else if (pgPool && text) {
    // Tekst-bestanden krijgen ook een `documents`-tabel-entry zodat ze
    // zichtbaar zijn in de Projectdata-submap van de bestandsbeheerder.
    // Geen file_bytes — de inhoud wordt als content_text in project_documents
    // bewaard en via die rij gedownload.
    try {
      const folderId = await findOrCreateProjectSubfolder(projectId, projectTitle, userId);
      const mime = mimeType || 'text/plain';
      const safeFilename = String(filename).slice(0, 200);
      const docResult = await pgPool.query(
        `INSERT INTO documents
           (title, filename, file_path, file_type, file_size, folder_id,
            uploaded_by, processing_status, total_chunks, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', 0, $8)
         RETURNING id`,
        [safeFilename, safeFilename, '', mime, size || 0, folderId, userId, mime]
      );
      documentRefId = docResult.rows[0]?.id || null;
      if (!documentRefId) console.warn('[project-doc upload] tekst-doc folder-entry aangemaakt maar geen id teruggekregen');
    } catch (e) {
      // Niet fataal: document_ref_id blijft null, bestand is wel opgeslagen.
      console.warn('[project-doc upload] tekst-doc folder-entry mislukt:', e.message);
    }
  }

  // Sla op in project_documents voor de project-eigen boekhoudingslijst.
  const row = {
    project_id: projectId,
    filename: String(filename).slice(0, 200),
    content_text: text,
    byte_size: size || (text ? Buffer.byteLength(text, 'utf8') : 0),
    mime_type: mimeType || (isBinaryDownload ? 'application/octet-stream' : null),
    uploaded_by: userId,
    document_ref_id: documentRefId,
    is_visible_to_students: true,
  };
  if (materialKind) row.material_kind = materialKind;
  const { data, error: e } = await supabaseAdmin
    .from('project_documents').insert(row)
    .select('id, filename, byte_size, mime_type, material_kind, document_ref_id, is_visible_to_students, uploaded_by, created_at').single();
  if (e) throw { status: 500, message: e.message };
  const folderLinkFailed = !isBinaryDownload && text && !data.document_ref_id;
  return { document: data, ...(folderLinkFailed ? { warning: 'Bestand opgeslagen, maar kon niet in de Projectdata-map worden geplaatst (controleer de serverlogs).' } : {}) };
}
