// Task #334 — pure helper voor het veilig hergebruiken van een RAG-map.
//
// Achtergrond: /api/admin/create-rag-folder en ensureCourseRagFolder zochten een
// bestaande map op via `name = 'RAG - <cursusnaam>'`. Omdat de cursusnaam (en dus
// de mapnaam) niet uniek per cursus is, kon een docent van cursus A — door een
// gemanipuleerde of toevallig botsende naam — een map die al aan cursus B hangt
// laten hergebruiken en aan cursus A koppelen (cross-course mutatie). Deze helper
// maakt de hergebruik-beslissing deterministisch en afdwingbaar: een map mag
// ALLEEN hergebruikt worden als ze nergens aan hangt, of uitsluitend aan déze
// cursus. Hangt ze (ook) aan een andere cursus, dan komt ze NOOIT in aanmerking.

/**
 * Kies een veilig herbruikbare RAG-map voor een cursus.
 *
 * @param {Object} params
 * @param {Array<{id:string}>} params.folders - kandidaat-mappen (naam+type-match).
 * @param {Object<string, Array<string>>} params.assignmentsByFolderId - per
 *   folder-id de lijst van course_id's waaraan de map gekoppeld is.
 * @param {string} params.courseId - de cursus waarvoor we een map zoeken.
 * @returns {string|null} folder-id die veilig hergebruikt mag worden, of null
 *   (dan moet de aanroeper een nieuwe map aanmaken).
 */
export function pickReusableRagFolder({ folders, assignmentsByFolderId, courseId }) {
  if (!courseId) return null;
  for (const f of folders || []) {
    if (!f || !f.id) continue;
    const assigned = (assignmentsByFolderId && assignmentsByFolderId[f.id]) || [];
    // Veilig als de map nergens hangt, of uitsluitend aan déze cursus.
    if (assigned.length === 0 || assigned.every((c) => c === courseId)) {
      return f.id;
    }
  }
  return null;
}

/**
 * Zorgt dat er een RAG-map (`RAG - <cursusnaam>`) bestaat, met permissies en
 * een koppeling aan de cursus. Hergebruikt een bestaande map (idempotent).
 * Een echte databasefout wordt nooit als "niets gevonden" gelezen (anders een
 * dubbele map of koppeling); de fout gaat omhoog zodat de aanroep opnieuw kan.
 * Retourneert { folderId, created }.
 */
export async function ensureCourseRagFolderWith(supabaseAdmin, courseId, courseName, userId) {
  // 1) Heeft de cursus al een gekoppelde RAG-map? Hergebruik die dan, ook als de
  //    cursusnaam intussen is gewijzigd. Dit voorkomt dubbele mappen.
  const { data: assignments, error: assignmentsErr } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('folder_id')
    .eq('course_id', courseId);
  // Een echte query-fout NIET als "geen koppeling" behandelen: anders zou een
  // transiënte fout een tweede RAG-map laten aanmaken voor een cursus die er al
  // één heeft (duplicaat). Surface de fout zodat de aanroep opnieuw kan draaien.
  if (assignmentsErr) throw new Error(`Kon cursuskoppelingen niet opzoeken: ${assignmentsErr.message}`);
  const assignedIds = (assignments || []).map((a) => a.folder_id).filter(Boolean);
  if (assignedIds.length > 0) {
    const { data: ragFolder, error: ragFolderErr } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', assignedIds)
      .eq('folder_type', 'rag_sources')
      .limit(1)
      .maybeSingle();
    if (ragFolderErr) throw new Error(`Kon gekoppelde RAG-map niet opzoeken: ${ragFolderErr.message}`);
    if (ragFolder) {
      return { folderId: ragFolder.id, created: false };
    }
  }

  // 2) Anders: zoek op naam (mogelijk al aangemaakt zonder koppeling), maar
  //    hergebruik ALLEEN een map die nergens hangt of uitsluitend aan déze
  //    cursus. Hangt een naam-match (ook) aan een ándere cursus, dan komt ze
  //    NOOIT in aanmerking (anders zou een naam-botsing tot cross-course
  //    koppeling leiden) → dan maken we een nieuwe map.
  const { data: namedFolders, error: namedFoldersErr } = await supabaseAdmin
    .from('document_folders')
    .select('id')
    .eq('name', `RAG - ${courseName}`)
    .eq('folder_type', 'rag_sources');
  // Transiënte fout niet als "geen naam-match" behandelen → zou een herbruikbare
  // map missen en een duplicaat aanmaken. Surface de fout.
  if (namedFoldersErr) throw new Error(`Kon mappen op naam niet opzoeken: ${namedFoldersErr.message}`);

  const assignmentsByFolderId = {};
  for (const f of namedFolders || []) {
    const { data: asg, error: asgErr } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('course_id')
      .eq('folder_id', f.id);
    // Fout niet negeren: een gemiste koppeling zou een map ten onrechte als
    // herbruikbaar (of juist niet) kunnen markeren — surface in plaats van raden.
    if (asgErr) throw new Error(`Kon mapkoppelingen niet opzoeken: ${asgErr.message}`);
    assignmentsByFolderId[f.id] = (asg || []).map((a) => a.course_id).filter(Boolean);
  }
  const reusableFolderId = pickReusableRagFolder({
    folders: namedFolders || [],
    assignmentsByFolderId,
    courseId,
  });

  let folderId;
  let created = false;
  if (reusableFolderId) {
    folderId = reusableFolderId;
  } else {
    const { data: newFolder, error: folderError } = await supabaseAdmin
      .from('document_folders')
      .insert({
        name: `RAG - ${courseName}`,
        description: `RAG-bronnen voor cursus ${courseName}`,
        parent_folder_id: null,
        created_by: userId,
        folder_type: 'rag_sources',
        is_root: false,
      })
      .select()
      .single();
    if (folderError || !newFolder) {
      throw new Error(`Kon RAG-map niet aanmaken: ${folderError?.message || 'onbekende fout'}`);
    }
    folderId = newFolder.id;
    created = true;

    const { error: permError } = await supabaseAdmin
      .from('folder_permissions')
      .insert([
        { folder_id: folderId, role: 'admin', can_view: true, can_edit: true },
        { folder_id: folderId, role: 'docent', can_view: true, can_edit: true },
        { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
      ]);
    if (permError) {
      console.warn('[ensureCourseRagFolder] permissions insert error (non-fatal):', permError.message);
    }
  }

  const { data: existingAssignment, error: existingAssignmentErr } = await supabaseAdmin
    .from('course_folder_assignments')
    .select('id')
    .eq('course_id', courseId)
    .eq('folder_id', folderId)
    .maybeSingle();
  // Fout niet als "nog niet gekoppeld" behandelen → zou een dubbele koppeling-insert
  // forceren. Surface de fout.
  if (existingAssignmentErr) throw new Error(`Kon bestaande koppeling niet opzoeken: ${existingAssignmentErr.message}`);
  if (!existingAssignment) {
    const { error: assignError } = await supabaseAdmin
      .from('course_folder_assignments')
      .insert({ course_id: courseId, folder_id: folderId });
    if (assignError) {
      throw new Error(`Kon map niet koppelen aan cursus: ${assignError.message}`);
    }
  }

  return { folderId, created };
}
