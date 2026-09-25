// Cursusmateriaal-beheer met bestandsdoelen (herinrichting docentenbeheer,
// 2026-09-25). Eén plek waar een docent alle bestanden van een cursus ziet, per
// bestand een DOEL kiest (zie filePurpose.js) en ziet of de cursus "klaar voor
// studenten" is.
//
// Ontwerp (belangrijk voor terugdraaien, zie supabase/rollback/...):
//  * Het doel is een laag BOVENOP het bestaande mapmodel. Leerstof en
//    cursusinformatie blijven in de RAG-map van de cursus (bucket rag_sources);
//    alleen documents.purpose maakt het onderscheid. Valt die kolom weg, dan is
//    alles in de RAG-map weer gewone leerstof — exact het oude gedrag.
//  * "Delen" en "Alleen docenten" krijgen elk een eigen (niet-RAG) cursusmap met
//    een marker in de description. Teacher-only bytes staan in
//    documents.file_bytes (storage-reads zijn open voor elke ingelogde
//    gebruiker; de documents-RLS schermt teacher_only af).
//  * Projectmateriaal gaat via createProjectDocumentFromBuffer naar het
//    bestaande projectdocumentsysteem.
//
// Alle routes: alleen admin of docent van de cursus (isStaffForCourse).

import {
  suggestPurpose,
  effectivePurpose,
  isRagPurpose,
  purposeAllowsModule,
  looksSensitive,
  DOCUMENT_PURPOSES,
  MATERIAL_KINDS,
} from './filePurpose.js';
import { computeTeacherFolderScope } from './documentScope.js';

export const PURPOSE_FOLDERS = {
  shared: { name: 'Gedeeld met studenten', marker: 'purpose:shared', studentView: true },
  teacher_only: { name: 'Alleen docenten', marker: 'purpose:teacher_only', studentView: false },
};

// Bestandstypen die de RAG-pijplijn kan verwerken tot tekstfragmenten.
export const RAG_PROCESSABLE_EXT = new Set(['pdf', 'docx', 'pptx', 'txt', 'md']);

const extOf = (doc) => String(doc?.file_type || doc?.filename?.split('.').pop() || '').toLowerCase().replace(/^\./, '');
const safeName = (n) => String(n || 'bestand').replace(/[^a-zA-Z0-9._\- ]/g, '_');

/**
 * Pure planning van een doelwijziging. Geeft aan welke fysieke stappen nodig
 * zijn, zodat de logica los testbaar is.
 */
export function planPurposeChange({ from, to, isWeb = false, ext = '' }) {
  if (!DOCUMENT_PURPOSES.includes(to) && to !== 'project') return { ok: false, error: 'invalidPurpose' };
  if (from === to) return { ok: true, kind: 'noop' };
  const fromRag = isRagPurpose(from);
  const toRag = isRagPurpose(to);
  if (isWeb && !toRag) return { ok: false, error: 'webPageOnlyRag' };
  if (toRag && !fromRag && !RAG_PROCESSABLE_EXT.has(ext)) return { ok: false, error: 'notProcessable' };
  if (to === 'project') return { ok: true, kind: 'toProject', dropChunks: fromRag, docChanged: fromRag };
  if (fromRag && toRag) {
    // Alleen het label verandert; de fragmenten blijven. Wordt het cursusinfo,
    // dan mag het geen bewijs meer leveren voor begrippen/quiz.
    return { ok: true, kind: 'relabel', dropEvidence: to === 'course_info', docChanged: true };
  }
  if (toRag) return { ok: true, kind: 'toRag', reprocess: true, docChanged: true };
  return { ok: true, kind: 'toNonRag', dropChunks: fromRag, docChanged: fromRag };
}

/** Pure: waarschuwingen voor het gereedheidsoverzicht. */
export function buildReadinessWarnings({ files, concepts, projects }) {
  const warnings = [];
  const add = (code, severity, step, items) => {
    if (items.length > 0) warnings.push({ code, severity, step, count: items.length, items: items.slice(0, 8) });
  };
  const material = files.filter(f => f.purpose === 'course_material');
  add('unconfirmedPurposes', 'warning', 'files', files.filter(f => !f.purposeConfirmed).map(f => f.title));
  add('noCourseMaterial', 'error', 'files', material.length === 0 ? ['—'] : []);
  add('sensitiveVisible', 'error', 'files',
    files.filter(f => f.purpose !== 'teacher_only' && looksSensitive(f)).map(f => f.title));
  const rag = files.filter(f => isRagPurpose(f.purpose));
  add('processingFailed', 'error', 'processing', rag.filter(f => f.processing_status === 'failed').map(f => f.title));
  add('processingBusy', 'info', 'processing', rag.filter(f => f.processing_status === 'processing' || f.processing_status === 'pending').map(f => f.title));
  add('noChunks', 'error', 'processing',
    rag.filter(f => f.processing_status === 'completed' && !f.isWeb && (f.total_chunks || 0) === 0).map(f => f.title));
  // Eén enorm fragment voor een groot bestand = chunking is misgegaan (CLAUDE.md).
  add('singleGiantChunk', 'warning', 'processing',
    rag.filter(f => f.processing_status === 'completed' && !f.isWeb && (f.total_chunks || 0) === 1 && (f.file_size || 0) > 50000).map(f => f.title));
  const visible = concepts.filter(c => c.visible);
  add('conceptsWithoutEvidence', 'warning', 'concepts', visible.filter(c => !c.quizReady).map(c => c.name));
  add('noConcepts', 'warning', 'concepts', material.length > 0 && concepts.length === 0 ? ['—'] : []);
  add('projectWithoutDocuments', 'info', 'files', projects.filter(p => p.documents.length === 0).map(p => p.title));
  return warnings;
}

export function registerCourseFilesRoutes(app, deps) {
  const {
    supabaseAdmin,
    pgPool,
    requireAuthUser,
    isStaffForCourse,
    ensureCourseRagFolder,
    processRagDocumentById,
    createProjectDocumentFromBuffer,
    getFileMimeType,
  } = deps;

  async function requireStaff(req, res) {
    const auth = await requireAuthUser(req, res);
    if (!auth) return null;
    const { courseId } = req.params;
    if (!courseId) { res.status(400).json({ error: 'courseId vereist' }); return null; }
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      return null;
    }
    return auth;
  }

  async function courseScope(courseId) {
    const { data: assigns, error } = await supabaseAdmin
      .from('course_folder_assignments').select('folder_id').eq('course_id', courseId);
    if (error) throw new Error(error.message);
    const { data: allFolders, error: fErr } = await supabaseAdmin
      .from('document_folders').select('id, name, description, parent_folder_id, folder_type, is_root');
    if (fErr) throw new Error(fErr.message);
    const assigned = (assigns || []).map(a => a.folder_id).filter(Boolean);
    const ids = computeTeacherFolderScope(assigned, allFolders || []);
    const folders = (allFolders || []).filter(f => ids.has(f.id));
    return { ids, folders, byId: new Map(folders.map(f => [f.id, f])), assigned: new Set(assigned) };
  }

  async function recordDocMutation(courseId) {
    const key = `__doc_mutation_${courseId}__`;
    const content = JSON.stringify({ lastMutationAt: new Date().toISOString() });
    const { data: existing } = await supabaseAdmin.from('chatbot_prompts').select('id').eq('name', key).maybeSingle();
    if (existing) await supabaseAdmin.from('chatbot_prompts').update({ content, updated_at: new Date().toISOString() }).eq('name', key);
    else await supabaseAdmin.from('chatbot_prompts').insert({ name: key, content, is_active: false });
  }

  async function courseName(courseId) {
    const { data } = await supabaseAdmin.from('courses').select('name').eq('id', courseId).maybeSingle();
    return data?.name || courseId;
  }

  /** Zoek of maak de cursusmap voor "Delen" / "Alleen docenten". */
  async function ensurePurposeFolder(courseId, purpose, userId) {
    const spec = PURPOSE_FOLDERS[purpose];
    if (!spec) throw new Error(`Geen map voor doel ${purpose}`);
    const scope = await courseScope(courseId);
    const existing = scope.folders.find(f => (f.description || '').includes(spec.marker));
    if (existing) return existing.id;
    const shell = scope.folders.find(f => f.folder_type === 'course' && !f.is_root) || null;
    const parentId = shell?.id || null;
    // Naambotsing binnen dezelfde ouder (UNIQUE parent,name): hergebruik die map
    // alleen als hij al bij deze cursus hoort, en markeer hem.
    const sameName = scope.folders.find(f => f.name === spec.name && (f.parent_folder_id || null) === parentId);
    if (sameName) {
      await supabaseAdmin.from('document_folders')
        .update({ description: `${sameName.description || ''} ${spec.marker}`.trim() }).eq('id', sameName.id);
      return sameName.id;
    }
    const result = await pgPool.query(
      `INSERT INTO document_folders (name, description, parent_folder_id, created_by, folder_type, is_root, bucket_type)
       VALUES ($1, $2, $3, $4, 'general', false, 'docs_general') RETURNING id`,
      [spec.name, `${spec.name} — ${spec.marker}`, parentId, userId],
    );
    const folderId = result.rows[0]?.id;
    if (!folderId) throw new Error('Kon map niet aanmaken');
    await pgPool.query(
      `INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
       VALUES ($1,'admin',true,true),($1,'docent',true,true),($1,'student',$2,false)
       ON CONFLICT DO NOTHING`,
      [folderId, spec.studentView],
    );
    await supabaseAdmin.from('course_folder_assignments').upsert(
      { course_id: courseId, folder_id: folderId },
      { onConflict: 'course_id,folder_id', ignoreDuplicates: true },
    );
    return folderId;
  }

  async function readBytes(doc) {
    const r = await pgPool.query('SELECT file_bytes FROM documents WHERE id = $1', [doc.id]);
    if (r.rows[0]?.file_bytes) return r.rows[0].file_bytes;
    if (doc.bucket && doc.file_path) {
      const { data, error } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
      if (error) throw new Error(`Bestand niet leesbaar: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    }
    throw new Error('Bestandsinhoud niet gevonden');
  }

  async function removeStorageObject(doc) {
    if (!doc.bucket || !doc.file_path || doc.file_type === 'web') return;
    const { error } = await supabaseAdmin.storage.from(doc.bucket).remove([doc.file_path]);
    if (error) console.warn(`[course-files] oude opslag niet verwijderd (${doc.bucket}/${doc.file_path}):`, error.message);
  }

  async function dropChunksAndEvidence(docId) {
    await supabaseAdmin.from('concept_evidence').delete().eq('document_id', docId);
    await supabaseAdmin.from('document_chunks').delete().eq('document_id', docId);
  }

  function startProcessing(docId) {
    processRagDocumentById(docId, 'nl').catch(async (err) => {
      console.error(`[course-files] verwerking mislukt voor doc=${docId}:`, err?.message || err);
      try { await supabaseAdmin.from('documents').update({ processing_status: 'failed' }).eq('id', docId); } catch { /* best effort */ }
    });
  }

  async function loadDoc(docId) {
    const { data } = await supabaseAdmin.from('documents')
      .select('id, title, filename, file_path, file_type, file_size, folder_id, bucket, mime_type, purpose, purpose_confirmed_at, processing_status, total_chunks')
      .eq('id', docId).maybeSingle();
    return data;
  }

  /**
   * Voer een doelwijziging uit (incl. verplaatsen van bytes). Gooit {status, code, message}.
   * Volgorde: nieuwe kopie eerst, dan DB bijwerken, dan oude kopie opruimen.
   */
  async function applyPurpose({ courseId, doc, folder, to, projectId, materialKind, userId }) {
    const from = effectivePurpose(doc, folder);
    const plan = planPurposeChange({ from, to, isWeb: doc.file_type === 'web', ext: extOf(doc) });
    if (!plan.ok) throw { status: 400, code: plan.error, message: plan.error };
    const now = new Date().toISOString();

    if (plan.kind === 'noop') {
      await supabaseAdmin.from('documents').update({ purpose: to === 'project' ? doc.purpose : to, purpose_confirmed_at: now }).eq('id', doc.id);
      return { purpose: to };
    }

    if (plan.kind === 'relabel') {
      if (plan.dropEvidence) await supabaseAdmin.from('concept_evidence').delete().eq('document_id', doc.id);
      await supabaseAdmin.from('documents').update({ purpose: to, purpose_confirmed_at: now }).eq('id', doc.id);
      await recordDocMutation(courseId);
      return { purpose: to };
    }

    if (plan.kind === 'toProject') {
      if (!projectId) throw { status: 400, code: 'projectRequired', message: 'Kies een project' };
      const { data: project } = await supabaseAdmin.from('projects').select('id, title, course_id').eq('id', projectId).maybeSingle();
      if (!project || project.course_id !== courseId) throw { status: 400, code: 'projectNotInCourse', message: 'Project hoort niet bij deze cursus' };
      const bytes = await readBytes(doc);
      const created = await createProjectDocumentFromBuffer({
        projectId, projectTitle: project.title, userId,
        filename: doc.filename || doc.title, buffer: bytes,
        mimeType: doc.mime_type || getFileMimeType(extOf(doc)), size: bytes.length,
        materialKind: MATERIAL_KINDS.includes(materialKind) ? materialKind : undefined,
      });
      await supabaseAdmin.from('documents').delete().eq('id', doc.id); // chunks/evidence cascaden
      await removeStorageObject(doc);
      if (plan.docChanged) await recordDocMutation(courseId);
      return { purpose: 'project', projectDocument: created.document };
    }

    const bytes = await readBytes(doc);
    const name = safeName(doc.filename || doc.title);

    if (plan.kind === 'toRag') {
      const { folderId } = await ensureCourseRagFolder(courseId, await courseName(courseId), userId);
      const path = `${folderId}/${Date.now()}_${name}`;
      const { error: upErr } = await supabaseAdmin.storage.from('rag_sources')
        .upload(path, bytes, { contentType: doc.mime_type || getFileMimeType(extOf(doc)), upsert: false });
      if (upErr) throw { status: 500, code: 'storage', message: upErr.message };
      await pgPool.query(
        `UPDATE documents SET folder_id=$2, bucket='rag_sources', file_path=$3, file_bytes=NULL,
           processing_status='processing', total_chunks=0, purpose=$4, purpose_confirmed_at=now(), updated_at=now()
         WHERE id=$1`,
        [doc.id, folderId, path, to],
      );
      await removeStorageObject(doc);
      startProcessing(doc.id);
      await recordDocMutation(courseId);
      return { purpose: to, reprocessing: true };
    }

    // toNonRag: delen of alleen-docenten
    const folderId = await ensurePurposeFolder(courseId, to, userId);
    if (plan.dropChunks) await dropChunksAndEvidence(doc.id);
    if (to === 'shared') {
      const path = `${folderId}/${Date.now()}_${name}`;
      const { error: upErr } = await supabaseAdmin.storage.from('docs_general')
        .upload(path, bytes, { contentType: doc.mime_type || getFileMimeType(extOf(doc)), upsert: false });
      if (upErr) throw { status: 500, code: 'storage', message: upErr.message };
      await pgPool.query(
        `UPDATE documents SET folder_id=$2, bucket='docs_general', file_path=$3, file_bytes=NULL,
           processing_status='completed', total_chunks=0, purpose='shared', purpose_confirmed_at=now(), updated_at=now()
         WHERE id=$1`,
        [doc.id, folderId, path],
      );
    } else {
      await pgPool.query(
        `UPDATE documents SET folder_id=$2, bucket='documents', file_path='', file_bytes=$3,
           processing_status='completed', total_chunks=0, purpose='teacher_only', purpose_confirmed_at=now(), updated_at=now()
         WHERE id=$1`,
        [doc.id, folderId, bytes],
      );
    }
    await removeStorageObject(doc);
    if (plan.docChanged) await recordDocMutation(courseId);
    return { purpose: to };
  }

  async function listProjects(courseId) {
    const { data: projects } = await supabaseAdmin.from('projects').select('id, title').eq('course_id', courseId).order('title');
    const ids = (projects || []).map(p => p.id);
    const { data: pdocs } = ids.length
      ? await supabaseAdmin.from('project_documents')
        .select('id, project_id, filename, byte_size, mime_type, material_kind, is_visible_to_students, document_ref_id, created_at')
        .in('project_id', ids).order('created_at', { ascending: false })
      : { data: [] };
    return {
      projects: (projects || []).map(p => ({
        id: p.id,
        title: p.title,
        documents: (pdocs || []).filter(d => d.project_id === p.id).map(d => ({
          ...d,
          material_kind: d.material_kind || (d.mime_type && !/^text\//.test(d.mime_type) && /octet|spreadsheet|csv/.test(d.mime_type) ? 'data' : null),
        })),
      })),
      linkedDocIds: new Set((pdocs || []).map(d => d.document_ref_id).filter(Boolean)),
    };
  }

  async function listFiles(courseId) {
    const scope = await courseScope(courseId);
    const folderIds = [...scope.ids];
    const { data: docs, error } = folderIds.length
      ? await supabaseAdmin.from('documents')
        .select('id, title, filename, file_type, file_size, folder_id, bucket, mime_type, purpose, purpose_confirmed_at, processing_status, total_chunks, created_at')
        .in('folder_id', folderIds).order('created_at', { ascending: false })
      : { data: [], error: null };
    if (error) throw new Error(error.message);
    const { projects, linkedDocIds } = await listProjects(courseId);
    const own = (docs || []).filter(d => !linkedDocIds.has(d.id));
    // Eerste fragment als tekstvoorbeeld voor het doelvoorstel.
    const unconfirmedRag = own.filter(d => !d.purpose_confirmed_at && d.bucket === 'rag_sources').map(d => d.id);
    const samples = new Map();
    if (unconfirmedRag.length) {
      const { data: first } = await supabaseAdmin.from('document_chunks')
        .select('document_id, content').in('document_id', unconfirmedRag).eq('chunk_index', 0);
      for (const c of first || []) samples.set(c.document_id, (c.content || '').slice(0, 3000));
    }
    const files = own.map(d => {
      const folder = scope.byId.get(d.folder_id);
      const purpose = effectivePurpose(d, folder);
      return {
        id: d.id,
        title: d.title || d.filename,
        filename: d.filename,
        file_type: d.file_type,
        file_size: d.file_size,
        created_at: d.created_at,
        processing_status: d.processing_status,
        total_chunks: d.total_chunks,
        isWeb: d.file_type === 'web',
        folderName: folder?.name || null,
        purpose,
        purposeConfirmed: !!d.purpose_confirmed_at,
        suggestion: d.purpose_confirmed_at ? null : suggestPurpose({
          filename: d.filename, title: d.title, fileType: d.file_type, textSample: samples.get(d.id) || '',
        }),
      };
    });
    return { files, projects, scope };
  }

  // ── GET: alle bestanden van de cursus met doel + projecten ──────────────────
  app.get('/api/admin/course-files/:courseId', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    try {
      const { files, projects } = await listFiles(req.params.courseId);
      return res.json({ files, projects, unconfirmedCount: files.filter(f => !f.purposeConfirmed).length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST: uploaden met doel ────────────────────────────────────────────────
  app.post('/api/admin/course-files/:courseId/upload', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    const { filename, mimeType, data: base64Data, purpose, projectId, materialKind } = req.body || {};
    if (!filename || !base64Data) return res.status(400).json({ error: 'filename en data zijn verplicht' });
    if (!DOCUMENT_PURPOSES.includes(purpose) && purpose !== 'project') return res.status(400).json({ error: 'Ongeldig doel', code: 'invalidPurpose' });
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = String(filename.split('.').pop() || '').toLowerCase();
      const mime = mimeType || getFileMimeType(ext);

      if (purpose === 'project') {
        if (!projectId) return res.status(400).json({ error: 'Kies een project', code: 'projectRequired' });
        const { data: project } = await supabaseAdmin.from('projects').select('id, title, course_id').eq('id', projectId).maybeSingle();
        if (!project || project.course_id !== courseId) return res.status(400).json({ error: 'Project hoort niet bij deze cursus', code: 'projectNotInCourse' });
        const created = await createProjectDocumentFromBuffer({
          projectId, projectTitle: project.title, userId: auth.user.id, filename, buffer, mimeType: mime, size: buffer.length,
          materialKind: MATERIAL_KINDS.includes(materialKind) ? materialKind : undefined,
        });
        return res.json({ purpose: 'project', ...created });
      }

      if (isRagPurpose(purpose) && !RAG_PROCESSABLE_EXT.has(ext)) {
        return res.status(400).json({ error: 'Dit bestandstype kan niet als leerstof of cursusinformatie worden verwerkt (pdf, docx, pptx, txt).', code: 'notProcessable' });
      }

      let folderId;
      let bucket;
      let filePath = '';
      if (isRagPurpose(purpose)) {
        ({ folderId } = await ensureCourseRagFolder(courseId, await courseName(courseId), auth.user.id));
        bucket = 'rag_sources';
      } else {
        folderId = await ensurePurposeFolder(courseId, purpose, auth.user.id);
        bucket = purpose === 'shared' ? 'docs_general' : 'documents';
      }
      if (purpose !== 'teacher_only') {
        filePath = `${folderId}/${Date.now()}_${safeName(filename)}`;
        const { error: upErr } = await supabaseAdmin.storage.from(bucket).upload(filePath, buffer, { contentType: mime, upsert: false });
        if (upErr) return res.status(500).json({ error: `Opslaan mislukt: ${upErr.message}` });
      }
      const inserted = await pgPool.query(
        `INSERT INTO documents (title, filename, file_path, file_type, file_size, folder_id, bucket, mime_type,
            uploaded_by, processing_status, total_chunks, purpose, purpose_confirmed_at, file_bytes)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,now(),$11) RETURNING id`,
        [filename, filePath, ext, buffer.length, folderId, bucket, mime, auth.user.id,
          isRagPurpose(purpose) ? 'processing' : 'completed', purpose, purpose === 'teacher_only' ? buffer : null],
      );
      const docId = inserted.rows[0]?.id;
      if (!docId) return res.status(500).json({ error: 'Kon bestand niet registreren' });
      if (isRagPurpose(purpose)) {
        startProcessing(docId);
        await recordDocMutation(courseId);
      }
      return res.json({ purpose, documentId: docId, processing: isRagPurpose(purpose) });
    } catch (err) {
      if (err && typeof err.status === 'number') return res.status(err.status).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  async function checkedDoc(courseId, docId) {
    const scope = await courseScope(courseId);
    const doc = await loadDoc(docId);
    if (!doc || !scope.ids.has(doc.folder_id)) return null;
    return { doc, folder: scope.byId.get(doc.folder_id) };
  }

  // ── PATCH: doel van één bestand wijzigen ────────────────────────────────────
  app.patch('/api/admin/course-files/:courseId/documents/:docId', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    const { courseId, docId } = req.params;
    const { purpose, projectId, materialKind } = req.body || {};
    try {
      const found = await checkedDoc(courseId, docId);
      if (!found) return res.status(404).json({ error: 'Bestand niet gevonden in deze cursus' });
      const result = await applyPurpose({ courseId, ...found, to: purpose, projectId, materialKind, userId: auth.user.id });
      return res.json(result);
    } catch (err) {
      if (err && typeof err.status === 'number') return res.status(err.status).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ── POST: eenmalige controle — meerdere besluiten tegelijk toepassen ───────
  app.post('/api/admin/course-files/:courseId/review', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    const results = [];
    for (const d of decisions) {
      try {
        const found = await checkedDoc(courseId, d.docId);
        if (!found) { results.push({ docId: d.docId, ok: false, error: 'notFound' }); continue; }
        const r = await applyPurpose({
          courseId, ...found, to: d.purpose, projectId: d.projectId, materialKind: d.materialKind, userId: auth.user.id,
        });
        results.push({ docId: d.docId, ok: true, ...r });
      } catch (err) {
        results.push({ docId: d.docId, ok: false, error: err?.code || err?.message || String(err) });
      }
    }
    return res.json({ results, ok: results.every(r => r.ok) });
  });

  // ── GET: klaar voor studenten? ──────────────────────────────────────────────
  app.get('/api/admin/course-readiness/:courseId', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    try {
      const { files, projects, scope } = await listFiles(courseId);

      // Documenten die de quiz mag gebruiken: RAG-mappen van de cursus met een
      // actieve quiz-koppeling (zelfde regel als /api/rag-enabled-folders,
      // incl. de terugval "geen koppelingen = alles"), en een doel dat quiz toestaat.
      const ragFolders = scope.folders.filter(f => f.folder_type === 'rag_sources' && scope.assigned.has(f.id)).map(f => f.id);
      let quizFolders = ragFolders;
      if (ragFolders.length) {
        const { data: fra } = await supabaseAdmin.from('folder_rag_assignments')
          .select('folder_id').in('folder_id', ragFolders).eq('module_type', 'quiz').eq('is_active', true);
        if ((fra || []).length) quizFolders = fra.map(r => r.folder_id);
      }
      const { data: quizDocs } = quizFolders.length
        ? await supabaseAdmin.from('documents').select('id, purpose').in('folder_id', quizFolders).eq('bucket', 'rag_sources')
        : { data: [] };
      const quizDocIds = new Set((quizDocs || []).filter(d => purposeAllowsModule(d.purpose, 'quiz')).map(d => d.id));

      let conceptRows = [];
      const byCol = await supabaseAdmin.from('concepts')
        .select('id, name, definition, key_points, review_status, concept_role, difficulty').eq('course_id', courseId);
      if (!byCol.error) conceptRows = byCol.data || [];
      const byMarker = await supabaseAdmin.from('concepts')
        .select('id, name, definition, key_points, review_status, concept_role, difficulty').contains('key_points', [`course_id:${courseId}`]);
      if (!byMarker.error) {
        const seen = new Set(conceptRows.map(c => c.id));
        for (const c of byMarker.data || []) if (!seen.has(c.id)) conceptRows.push(c);
      }
      const conceptIds = conceptRows.map(c => c.id);
      const { data: evidence } = conceptIds.length
        ? await supabaseAdmin.from('concept_evidence').select('concept_id, document_id').in('concept_id', conceptIds)
        : { data: [] };
      const { data: itembank } = conceptIds.length
        ? await supabaseAdmin.from('concept_itembank_sections').select('concept_id').eq('course_id', courseId)
        : { data: [] };

      const concepts = conceptRows.map(c => {
        const ev = (evidence || []).filter(e => e.concept_id === c.id);
        const quizEv = ev.filter(e => quizDocIds.has(e.document_id));
        return {
          id: c.id,
          name: c.name,
          visible: c.review_status !== 'rejected',
          role: c.concept_role || null,
          difficulty: c.difficulty || null,
          evidenceDocuments: new Set(ev.map(e => e.document_id)).size,
          quizReady: quizEv.length > 0,
          itembankSections: (itembank || []).filter(i => i.concept_id === c.id).length,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, 'nl'));

      const counts = {};
      for (const f of files) counts[f.purpose] = (counts[f.purpose] || 0) + 1;
      counts.project = (counts.project || 0) + projects.reduce((n, p) => n + p.documents.length, 0);

      const warnings = buildReadinessWarnings({ files, concepts, projects });
      return res.json({ counts, concepts, projects, warnings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST: zichtbaarheid van één begrip (i.p.v. alles-of-niets set-approval) ──
  app.post('/api/admin/course-files/:courseId/concepts/:conceptId/visibility', async (req, res) => {
    const auth = await requireStaff(req, res);
    if (!auth) return;
    const { courseId, conceptId } = req.params;
    const visible = req.body?.visible;
    if (typeof visible !== 'boolean') return res.status(400).json({ error: 'visible moet een boolean zijn' });
    try {
      const { data: c } = await supabaseAdmin.from('concepts').select('id, course_id, key_points').eq('id', conceptId).maybeSingle();
      const inCourse = c && (c.course_id === courseId || (Array.isArray(c.key_points) && c.key_points.includes(`course_id:${courseId}`)));
      if (!inCourse) return res.status(404).json({ error: 'Begrip niet gevonden in deze cursus' });
      const { error } = await supabaseAdmin.from('concepts').update({ review_status: visible ? 'approved' : 'rejected' }).eq('id', conceptId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ id: conceptId, visible });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET (studenten): gedeelde bestanden van de cursus voor /resources ──────
  app.get('/api/courses/:courseId/shared-files', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    try {
      if (!(await deps.userHasCourseAccess(auth.user, auth.profile, courseId))) {
        return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      }
      const scope = await courseScope(courseId);
      const shared = scope.folders.filter(f => (f.description || '').includes(PURPOSE_FOLDERS.shared.marker)).map(f => f.id);
      const { data } = shared.length
        ? await supabaseAdmin.from('documents')
          .select('id, title, filename, file_type, file_size, file_path, bucket, created_at')
          .in('folder_id', shared).eq('purpose', 'shared').order('title')
        : { data: [] };
      return res.json({ files: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
