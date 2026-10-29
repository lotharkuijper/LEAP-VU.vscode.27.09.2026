import { canRequestDocumentReview, feedbackRoundsState } from './documentReview.js';
import { MATERIAL_KINDS } from '../rag/filePurpose.js';
import { buildLanguageInstruction, normalizeLang } from '../i18n/languages.js';
import {
  authUser,
  isCourseTeacher,
  isLeapAdmin,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
} from '../lib/auth.js';
import { AZURE_CHAT_READY, OPENAI_MODEL, chatModelParams, openaiChatCompletion } from '../lib/azureOpenai.js';
import { SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import { BINARY_DOWNLOAD_EXT_RE, docUpload, extractTextFromUpload } from '../lib/uploads.js';
import { createPreassessmentRunner, registerPreassessmentRoutes } from './preassessment.js';
import { isSaved, reviewRefs } from './projectJournalSave.js';
import { isGroupMember, requireProjectStaff, userHasProjectAccess } from './access.js';
import { loadFeedbackContext, runEvaluatorReview } from './evaluatorReview.js';
import { createProjectDocumentFromBuffer } from './projectFiles.js';

// PATCH /api/projects/:projectId/documents/:docId — zichtbaarheid voor studenten
// Haalt een projectdocument weg uit wat persona's kennen (verwijderd, of nu een
// databestand). Geeft de namen terug van de persona's die het kenden.
async function forgetProjectDocKnowledge(projectId, docId) {
  const { data: personas } = await supabaseAdmin.from('project_personas')
    .select('id, name, project_knowledge_doc_ids').eq('project_id', projectId)
    .contains('project_knowledge_doc_ids', [docId]);
  for (const p of personas || []) {
    await supabaseAdmin.from('project_personas')
      .update({ project_knowledge_doc_ids: (p.project_knowledge_doc_ids || []).filter(id => id !== docId) })
      .eq('id', p.id);
  }
  return (personas || []).map(p => p.name);
}

// Leerlijn: volgorde van de stof per cursus (server/courseUnits.js).
// Voorbeoordeling van het ingeleverde eindproduct (server/preassessment.js).
const preassessmentRunner = createPreassessmentRunner({
  supabaseAdmin, pgPool,
  extractText: extractTextFromUpload,
  modelReady: () => AZURE_CHAT_READY,
  callModel: async (messages, lang) => {
    const withLang = messages.map((m, i) => (i === 0 ? { ...m, content: m.content + buildLanguageInstruction(lang, { json: true }) } : m));
    const r = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: withLang,
      response_format: { type: 'json_object' },
      ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
    }, { timeoutMs: 240000 });
    if (!r.ok) throw new Error(`Taalmodel-fout (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  },
});

// =============================================================================
// Projectproduct-inleveringen (Task #156). Eén bestand per groep is de huidige
// regel — vervangen vervangt door een nieuwe rij + verwijdert oudere rijen
// voor dezelfde (project, groep). Architectuur staat versie-historie toe als
// het beleid later verandert (geen UNIQUE op (project_id, group_id)).
// =============================================================================

const SUBMISSION_MAX_BYTES = 15 * 1024 * 1024;

const SUBMISSION_ACCEPT_RE = /\.(pdf|docx|pptx|xlsx|odt|ods|odp|zip|txt|md|markdown|csv|tsv|json|rtf|jpg|jpeg|png|html|htm)$/i;

// GET /api/projects/:projectId/submissions?groupId=X
//   - groupId opgegeven: lijst voor die groep (lid of staff).
//   - geen groupId: alleen staff — alle groepen van het project.
async function listProjectSubmissionsHandler(req, res) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  const { groupId } = req.query;
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, course_id, submissions_enabled').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

    const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
    // 'Staff' = admin/superuser OF docent met cursus-lidmaatschap. Een docent
    // van een andere cursus mag deze submissions niet zien.
    const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
    const isCourseStaff = isAdmin
      || (project.course_id && await isCourseTeacher(auth.user.id, project.course_id));

    if (!isCourseStaff) {
      // Niet-staff: moet lid zijn van de opgevraagde groep.
      if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
      const member = await isGroupMember(groupId, auth.user.id);
      if (!member) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
    }

    let q = supabaseAdmin
      .from('project_submissions')
      .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (groupId) q = q.eq('group_id', groupId);
    const { data, error: e } = await q;
    if (e) return res.status(500).json({ error: e.message });

    const rows = data || [];
    const uploaderIds = Array.from(new Set(rows.map(r => r.uploaded_by).filter(Boolean)));
    let uploaderMap = new Map();
    if (uploaderIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, email, full_name').in('id', uploaderIds);
      uploaderMap = new Map((profs || []).map(p => [p.id, p]));
    }
    return res.json({
      submissions: rows.map(s => {
        const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
        return {
          id: s.id,
          project_id: s.project_id,
          group_id: s.group_id,
          group_name: s.project_groups?.name || null,
          uploaded_by: s.uploaded_by,
          uploaded_by_name: up?.full_name || up?.email || null,
          uploaded_by_email: up?.email || null,
          filename: s.filename,
          mime_type: s.mime_type,
          byte_size: s.byte_size,
          created_at: s.created_at,
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/projects/:projectId/submissions — student uploadt projectproduct
// voor de eigen groep. Vervangt eventuele oudere rij(en) voor deze groep.
async function uploadProjectSubmissionHandler(req, res) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
  if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
  const auth = await authUser(req);
  if (auth.error) return res.status(auth.error.status).json(auth.error.body);
  const { projectId } = req.params;
  const groupId = req.body?.groupId;
  if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
  const filename = String(req.file.originalname || 'upload').slice(0, 200);
  if (!SUBMISSION_ACCEPT_RE.test(filename)) {
    return res.status(400).json({ error: 'Niet-ondersteund bestandstype' });
  }
  if ((req.file.size || 0) > SUBMISSION_MAX_BYTES) {
    return res.status(400).json({ error: 'Bestand te groot (max 15 MB)' });
  }

  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, submissions_enabled, status, preassessment_persona_id').eq('id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
    if (!project.submissions_enabled) {
      return res.status(403).json({ error: 'Inleveren is niet ingeschakeld voor dit project' });
    }
    if (project.status && project.status !== 'active') {
      return res.status(403).json({ error: 'Project is niet meer actief' });
    }

    const { data: group } = await supabaseAdmin
      .from('project_groups').select('id, project_id, status').eq('id', groupId).maybeSingle();
    if (!group || group.project_id !== projectId) {
      return res.status(404).json({ error: 'Groep niet gevonden voor dit project' });
    }
    if (group.status === 'archived') {
      return res.status(403).json({ error: 'Groep is gearchiveerd' });
    }

    const member = await isGroupMember(groupId, auth.user.id);
    if (!member) return res.status(403).json({ error: 'Je bent geen lid van deze groep' });

    // Vervang oudere inleveringen in één transactie: nieuwe rij invoegen,
    // dan alle eerdere rijen voor deze (project, groep) verwijderen.
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const insRes = await client.query(
        `INSERT INTO project_submissions
           (project_id, group_id, uploaded_by, filename, mime_type, file_bytes, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at`,
        [
          projectId, groupId, auth.user.id, filename,
          req.file.mimetype || 'application/octet-stream',
          req.file.buffer,
          req.file.size || 0,
        ]
      );
      const newId = insRes.rows[0].id;
      await client.query(
        'DELETE FROM project_submissions WHERE project_id = $1 AND group_id = $2 AND id <> $3',
        [projectId, groupId, newId]
      );
      await client.query('COMMIT');
      // Voorbeoordeling voor de docent (als er een voorbeoordelaar is
      // aangewezen): op de achtergrond, de student wacht er niet op.
      if (project.preassessment_persona_id) preassessmentRunner.start(newId);
      return res.json({ submission: insRes.rows[0], preassessment: !!project.preassessment_persona_id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[project-submission POST]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export function registerProjectDocumentRoutes(app) {
  // =============================================================================
  // Project-brede documenten (datasets/opdracht) — staff uploadt, alle leden
  // van elke groep in dit project zien ze read-only en alle persona's krijgen
  // de tekst automatisch als context.
  // =============================================================================

  app.get('/api/projects/:projectId/documents', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('*').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!(await userHasProjectAccess(auth.user, profile, project))) {
        return res.status(403).json({ error: 'Geen toegang tot dit project' });
      }
      const isStaffDocs = await isStaffForCourse(auth.user, profile, project.course_id);
      let docsQuery = supabaseAdmin
        .from('project_documents')
        .select('id, filename, byte_size, mime_type, material_kind, document_ref_id, is_visible_to_students, uploaded_by, created_at')
        .eq('project_id', projectId).order('created_at', { ascending: false });
      if (!isStaffDocs) docsQuery = docsQuery.eq('is_visible_to_students', true);
      const { data, error: e } = await docsQuery;
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ documents: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/documents', docUpload.single('file'), async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
    const filename = req.file.originalname || 'upload';
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const materialKind = MATERIAL_KINDS.includes(req.body?.material_kind) ? req.body.material_kind : undefined;
      const result = await createProjectDocumentFromBuffer({
        projectId,
        projectTitle: access.project?.title,
        userId: auth.user.id,
        filename,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        size: req.file.size,
        materialKind,
      });
      return res.json(result);
    } catch (err) {
      if (err && typeof err.status === 'number') return res.status(err.status).json({ error: err.message });
      console.error('[project-doc upload]', err?.message || err);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // GET /api/projects/:projectId/documents/:docId/download — streamt het
  // originele bestand. Toegankelijk voor groepsleden van het project en staff.
  app.get('/api/projects/:projectId/documents/:docId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, docId } = req.params;
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!(await userHasProjectAccess(auth.user, profile, project))) {
        return res.status(403).json({ error: 'Geen toegang tot dit project' });
      }
      const isStaffDl = await isStaffForCourse(auth.user, profile, project.course_id);
      const { data: doc } = await supabaseAdmin
        .from('project_documents')
        .select('filename, content_text, mime_type, document_ref_id, is_visible_to_students')
        .eq('id', docId).eq('project_id', projectId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      // Studenten mogen verborgen bestanden niet downloaden.
      if (!isStaffDl && !doc.is_visible_to_students) {
        return res.status(403).json({ error: 'Dit bestand is niet beschikbaar voor studenten' });
      }
      let buffer;
      let mimeType = doc.mime_type || 'application/octet-stream';
      if (doc.document_ref_id) {
        // Binair of tekst-bestand: zoek de documents-tabel-entry op.
        // Binair: file_bytes aanwezig → stuur die.
        // Tekst: file_bytes NULL → val terug op content_text uit project_documents.
        if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
        const result = await pgPool.query(
          'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
          [doc.document_ref_id]
        );
        if (result.rows[0]?.file_bytes) {
          buffer = result.rows[0].file_bytes;
          if (result.rows[0].mime_type) mimeType = result.rows[0].mime_type;
        } else if (doc.content_text != null) {
          // Tekst-bestand met folder-entry maar zonder file_bytes.
          buffer = Buffer.from(doc.content_text, 'utf8');
          mimeType = doc.mime_type || 'text/plain; charset=utf-8';
        } else {
          return res.status(404).json({ error: 'Bestandsinhoud niet gevonden' });
        }
      } else if (doc.content_text != null) {
        buffer = Buffer.from(doc.content_text, 'utf8');
        mimeType = doc.mime_type || 'text/plain; charset=utf-8';
      } else {
        return res.status(404).json({ error: 'Bestand bevat geen inhoud' });
      }
      const safeName = String(doc.filename || 'download').replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      return res.end(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // en/of soort materiaal (material_kind: assignment/data/literature/rubric/other) wijzigen.
  app.patch('/api/projects/:projectId/documents/:docId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, docId } = req.params;
    const { is_visible_to_students, material_kind } = req.body || {};
    const update = {};
    if (is_visible_to_students !== undefined) {
      if (typeof is_visible_to_students !== 'boolean') {
        return res.status(400).json({ error: 'is_visible_to_students moet een boolean zijn' });
      }
      update.is_visible_to_students = is_visible_to_students;
    }
    if (material_kind !== undefined) {
      if (material_kind !== null && !MATERIAL_KINDS.includes(material_kind)) {
        return res.status(400).json({ error: 'Ongeldige material_kind' });
      }
      update.material_kind = material_kind;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'is_visible_to_students moet een boolean zijn' });
    }
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const { data, error: e } = await supabaseAdmin
        .from('project_documents')
        .update(update)
        .eq('id', docId).eq('project_id', projectId)
        .select(Object.prototype.hasOwnProperty.call(update, 'material_kind') ? 'id, is_visible_to_students, material_kind' : 'id, is_visible_to_students').single();
      if (e) return res.status(500).json({ error: e.message });
      // Een databestand is nooit kennis van een persona (personaKnowledge.js).
      const forgottenBy = update.material_kind === 'data' ? await forgetProjectDocKnowledge(projectId, docId) : [];
      return res.json({ document: data, forgottenBy });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:projectId/documents/:docId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, docId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      // Haal eerst document_ref_id op zodat we de documents-rij ook kunnen verwijderen.
      const { data: docRow } = await supabaseAdmin
        .from('project_documents').select('document_ref_id')
        .eq('id', docId).eq('project_id', projectId).maybeSingle();
      const { error: e } = await supabaseAdmin
        .from('project_documents').delete()
        .eq('id', docId).eq('project_id', projectId);
      if (e) return res.status(500).json({ error: e.message });
      await forgetProjectDocKnowledge(projectId, docId);
      // Verwijder ook de bijbehorende rij in documents (binaire bestanden).
      if (docRow?.document_ref_id) {
        await supabaseAdmin.from('documents').delete().eq('id', docRow.document_ref_id);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:projectId/documents/:docId/reviews', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, docId } = req.params;
    const groupId = req.query.groupId;
    if (!groupId) return res.status(400).json({ error: 'groupId is vereist' });
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!(await userHasProjectAccess(auth.user, profile, project))) {
        return res.status(403).json({ error: 'Geen toegang tot dit project' });
      }
      // Coherentie-check: groep + document moeten écht bij dit project horen,
      // anders kan een docent uit project A reviews uit project B uitlezen door
      // een vreemde groupId/docId in de URL te zetten (IDOR).
      const [{ data: groupCheck }, { data: docCheck }] = await Promise.all([
        supabaseAdmin.from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle(),
        supabaseAdmin.from('project_documents').select('id, project_id').eq('id', docId).maybeSingle(),
      ]);
      if (!groupCheck || groupCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }
      if (!docCheck || docCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Document niet gevonden in dit project' });
      }
      const isStaff = isLeapAdmin(profile);
      const memberOfGroup = await isGroupMember(groupId, auth.user.id);
      if (!isStaff && !memberOfGroup) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      let { data, error: e } = await supabaseAdmin
        .from('project_document_reviews')
        .select('id, document_id, persona_id, group_id, verdict, grade, reasoning, feed_forward, relationship_delta, requested_by, created_at')
        .eq('document_id', docId).eq('group_id', groupId)
        .order('created_at', { ascending: false });
      // Defensief: oude DB zonder grade/feed_forward-kolommen.
      if (e && (e.code === '42703' || /grade|feed_forward/i.test(e.message || ''))) {
        ({ data, error: e } = await supabaseAdmin
          .from('project_document_reviews')
          .select('id, document_id, persona_id, group_id, verdict, reasoning, relationship_delta, requested_by, created_at')
          .eq('document_id', docId).eq('group_id', groupId)
          .order('created_at', { ascending: false }));
      }
      if (e) {
        // Tabel bestaat nog niet → defensief leeg antwoord met duidelijke uitleg.
        if (e.code === '42P01' || /project_document_reviews/i.test(e.message || '')) {
          return res.status(503).json({
            error: 'Migratie 20260528100000_project_document_reviews.sql is nog niet toegepast in Supabase.',
            reviews: [],
          });
        }
        return res.status(500).json({ error: e.message });
      }
      const reviews = data || [];
      // Task #253: badges per review voor deze groep ophalen. Studenten zien
      // alleen hun eigen badges; staff ziet ze allemaal.
      let badges = [];
      if (reviews.length > 0) {
        const reviewIds = reviews.map(r => r.id);
        let bq = supabaseAdmin
          .from('project_review_badges')
          .select('review_id, user_id, grade, badge, award_mode')
          .in('review_id', reviewIds);
        if (!isStaff) bq = bq.eq('user_id', auth.user.id);
        const { data: bData, error: bErr } = await bq;
        if (!bErr) badges = bData || [];
      }
      return res.json({ reviews, badges });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:projectId/groups/:groupId/feedback — per beoordelaar het
  // product, de rondes (gebruikt / maximum) en de eerdere feedback van de groep.
  app.get('/api/projects/:projectId/groups/:groupId/feedback', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    try {
      const ctx = await loadFeedbackContext(req, res, { requirePersona: false });
      if (!ctx) return;
      const { project, group, auth, isStaff } = ctx;
      const { data: evaluators } = await supabaseAdmin
        .from('project_personas')
        .select('id, name, avatar_emoji, avatar, deliverable_label, max_reviews, sort_order')
        .eq('project_id', project.id).eq('persona_type', 'evaluator').neq('id', project.preassessment_persona_id || '00000000-0000-0000-0000-000000000000').order('sort_order');
      const evIds = (evaluators || []).map(e => e.id);
      if (evIds.length === 0) return res.json({ evaluators: [] });
      const { data: products } = await supabaseAdmin
        .from('project_group_products')
        .select('id, persona_id, filename, byte_size, uploaded_by, created_at')
        .eq('group_id', group.id).in('persona_id', evIds)
        .order('created_at', { ascending: false });
      const productIds = (products || []).map(p => p.id);
      let reviews = [];
      if (productIds.length) {
        const { data } = await supabaseAdmin
          .from('project_document_reviews')
          .select('id, product_id, document_id, persona_id, verdict, grade, reasoning, feed_forward, created_at')
          .in('product_id', productIds);
        reviews = data || [];
      }
      let badges = [];
      if (reviews.length) {
        let bq = supabaseAdmin.from('project_review_badges').select('review_id, user_id, badge').in('review_id', reviews.map(r => r.id));
        if (!isStaff) bq = bq.eq('user_id', auth.user.id);
        const { data } = await bq;
        badges = data || [];
      }
      const reviewByProduct = new Map(reviews.map(r => [r.product_id, r]));
      // Staat dit oordeel al in MIJN leerdagboek? (projectJournalSave.js)
      const { data: mySaved } = reviews.length
        ? await supabaseAdmin.from('learning_journal_entries').select('source_ref')
          .eq('user_id', auth.user.id).in('source_ref', reviews.flatMap(r => reviewRefs(r)))
        : { data: [] };
      const mySavedSet = new Set((mySaved || []).map(e => e.source_ref));
      const out = (evaluators || []).map(ev => {
        const items = (products || []).filter(p => p.persona_id === ev.id).map(p => {
          const review = reviewByProduct.get(p.id) || null;
          const badge = review ? (badges.find(b => b.review_id === review.id)?.badge || null) : null;
          return { productId: p.id, filename: p.filename, createdAt: p.created_at, review, badge, journalSaved: review ? isSaved(reviewRefs(review), mySavedSet) : false };
        });
        const rounds = feedbackRoundsState(ev.max_reviews, items.filter(i => i.review).length);
        return {
          personaId: ev.id, name: ev.name, avatarEmoji: ev.avatar_emoji, avatar: ev.avatar ?? null,
          deliverableLabel: ev.deliverable_label || null,
          maxReviews: rounds.maxReviews, used: rounds.used, remaining: rounds.remaining, canSubmit: rounds.canSubmit,
          items,
        };
      });
      return res.json({ evaluators: out });
    } catch (err) {
      console.error('[feedback list]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/documents/:docId/reviews', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, docId } = req.params;
    const { personaId, groupId, lang } = req.body || {};
    const reviewLang = normalizeLang(lang);
    if (!personaId || !groupId) {
      return res.status(400).json({ error: 'personaId en groupId zijn vereist' });
    }
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id, title, research_question, goals, briefing_markdown')
        .eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      const memberOfGroup = await isGroupMember(groupId, auth.user.id);
      const authzCheck = canRequestDocumentReview({ isStaff, isGroupMember: memberOfGroup });
      if (!authzCheck.allowed) {
        return res.status(authzCheck.status).json({ error: authzCheck.error });
      }

      // Groep moet bij dit project horen.
      const { data: group } = await supabaseAdmin
        .from('project_groups').select('id, project_id, name').eq('id', groupId).maybeSingle();
      if (!group || group.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }

      // Persona moet evaluator zijn én bij dit project horen.
      let { data: persona } = await supabaseAdmin
        .from('project_personas').select('id, project_id, name, avatar_emoji, system_prompt, persona_type, badge_award_mode')
        .eq('id', personaId).maybeSingle();
      // Defensief: oude DB zonder badge_award_mode-kolom.
      if (!persona) {
        ({ data: persona } = await supabaseAdmin
          .from('project_personas').select('id, project_id, name, avatar_emoji, system_prompt, persona_type')
          .eq('id', personaId).maybeSingle());
      }
      if (!persona || persona.project_id !== projectId) {
        return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
      }
      if (persona.persona_type !== 'evaluator') {
        return res.status(400).json({ error: 'Alleen evaluator-persona\'s kunnen oordelen afgeven' });
      }
      {
        const { data: pre } = await supabaseAdmin.from('projects').select('preassessment_persona_id').eq('id', projectId).maybeSingle();
        if (pre?.preassessment_persona_id === persona.id) {
          return res.status(400).json({ error: 'Deze beoordelaar maakt alleen de voorbeoordeling van het eindproduct voor de docent' });
        }
      }

      // Document moet bij dit project horen en moet tekst-extraheerbaar zijn.
      const { data: doc } = await supabaseAdmin
        .from('project_documents')
        .select('id, project_id, filename, content_text, is_visible_to_students')
        .eq('id', docId).eq('project_id', projectId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      if (BINARY_DOWNLOAD_EXT_RE.test(doc.filename || '')) {
        return res.status(400).json({
          error: 'Dit bestand is geen tekstbestand — daarover kan geen tekstueel oordeel worden gegeven.',
        });
      }
      if (!doc.content_text || !doc.content_text.trim()) {
        return res.status(400).json({ error: 'Document bevat geen leesbare tekst om te beoordelen' });
      }
      if (!isStaff && !doc.is_visible_to_students) {
        return res.status(403).json({ error: 'Dit document is niet zichtbaar voor studenten' });
      }

      try {
        const { inserted, badge, awardMode, badgeRecipients } = await runEvaluatorReview({
          project, group, persona, title: doc.filename, text: doc.content_text,
          lang: reviewLang, requesterId: auth.user.id, documentId: docId,
        });
        return res.json({
          review: { ...inserted, badge: badge || null, award_mode: awardMode, badge_recipients: badgeRecipients },
        });
      } catch (e) {
        if (e && e.status) return res.status(e.status).json(e.body);
        throw e;
      }
    } catch (err) {
      console.error('[document_review]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  registerPreassessmentRoutes(app, { supabaseAdmin, pgPool, requireAuthUser, isStaffForCourse, runner: preassessmentRunner });

  app.get('/api/projects/:projectId/submissions', listProjectSubmissionsHandler);

  app.post('/api/projects/:projectId/submissions', docUpload.single('file'), uploadProjectSubmissionHandler);

  // GET /api/projects/:projectId/submissions/:subId/download — leden van de
  // groep + staff mogen downloaden.
  app.get('/api/projects/:projectId/submissions/:subId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    if (!pgPool) return res.status(503).json({ error: 'Directe DB-verbinding niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, subId } = req.params;
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      const isCourseStaff = isAdmin
        || (project.course_id && await isCourseTeacher(auth.user.id, project.course_id));

      const { data: sub } = await supabaseAdmin
        .from('project_submissions')
        .select('id, project_id, group_id, filename, mime_type')
        .eq('id', subId).eq('project_id', projectId).maybeSingle();
      if (!sub) return res.status(404).json({ error: 'Inlevering niet gevonden' });

      if (!isCourseStaff) {
        const member = await isGroupMember(sub.group_id, auth.user.id);
        if (!member) return res.status(403).json({ error: 'Geen toegang tot deze inlevering' });
      }

      const result = await pgPool.query(
        'SELECT file_bytes, mime_type FROM project_submissions WHERE id = $1',
        [subId]
      );
      const buffer = result.rows[0]?.file_bytes;
      if (!buffer) return res.status(404).json({ error: 'Bestandsinhoud niet gevonden' });
      const mimeType = result.rows[0]?.mime_type || sub.mime_type || 'application/octet-stream';
      const safeName = String(sub.filename || 'download').replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      return res.end(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/projects/:projectId/submissions/:subId — alleen staff.
  app.delete('/api/projects/:projectId/submissions/:subId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, subId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const { error: e } = await supabaseAdmin
        .from('project_submissions').delete()
        .eq('id', subId).eq('project_id', projectId);
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Alias-routes (taakcontract): /api/projects/:projectId/groups/:groupId/submissions
  // — semantisch identiek aan ?groupId=... maar als pad-parameter. We hergebruiken
  // de handlers direct (geen interne re-dispatch) zodat multer maar één keer
  // langs de multipart-stream gaat.
  app.get('/api/projects/:projectId/groups/:groupId/submissions', (req, res) => {
    req.query.groupId = req.params.groupId;
    return listProjectSubmissionsHandler(req, res);
  });

  app.post('/api/projects/:projectId/groups/:groupId/submissions', docUpload.single('file'), (req, res) => {
    req.body = req.body || {};
    req.body.groupId = req.params.groupId;
    return uploadProjectSubmissionHandler(req, res);
  });

  // GET /api/admin/courses/:courseId/submissions — cursus-brede staff overzicht:
  // alle inleveringen van alle projecten van deze cursus, met groep- en
  // project-context. Alleen admin/superuser of docent met course_members-record.
  app.get('/api/admin/courses/:courseId/submissions', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      const isCourseStaff = isAdmin
        || (await isCourseTeacher(auth.user.id, courseId));
      if (!isCourseStaff) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });

      const { data: projects } = await supabaseAdmin
        .from('projects').select('id, title').eq('course_id', courseId);
      const projectIds = (projects || []).map(p => p.id);
      if (!projectIds.length) return res.json({ submissions: [] });
      const projectMap = new Map((projects || []).map(p => [p.id, p]));

      const { data: rows, error: e } = await supabaseAdmin
        .from('project_submissions')
        .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false });
      if (e) return res.status(500).json({ error: e.message });

      const uploaderIds = Array.from(new Set((rows || []).map(r => r.uploaded_by).filter(Boolean)));
      let uploaderMap = new Map();
      if (uploaderIds.length) {
        const { data: profs } = await supabaseAdmin
          .from('profiles').select('id, email, full_name').in('id', uploaderIds);
        uploaderMap = new Map((profs || []).map(p => [p.id, p]));
      }
      return res.json({
        submissions: (rows || []).map(s => {
          const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
          const proj = projectMap.get(s.project_id);
          return {
            id: s.id,
            project_id: s.project_id,
            project_title: proj?.title || null,
            group_id: s.group_id,
            group_name: s.project_groups?.name || null,
            uploaded_by: s.uploaded_by,
            uploaded_by_name: up?.full_name || up?.email || null,
            uploaded_by_email: up?.email || null,
            filename: s.filename,
            mime_type: s.mime_type,
            byte_size: s.byte_size,
            created_at: s.created_at,
          };
        }),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/uploads-folder/:folderId/submissions — staff browse-pad voor
  // de Documenten-UI: resolve cursus via course_folder_assignments + folder_type
  // 'uploads', delegeer dan naar de cursus-brede submissions-listing.
  app.get('/api/admin/uploads-folder/:folderId/submissions', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { folderId } = req.params;
    try {
      const { data: folder } = await supabaseAdmin
        .from('document_folders').select('id, folder_type').eq('id', folderId).maybeSingle();
      if (!folder) return res.status(404).json({ error: 'Map niet gevonden' });
      if (folder.folder_type !== 'uploads') {
        return res.status(400).json({ error: 'Map is geen Uploads-map' });
      }
      const { data: assign } = await supabaseAdmin
        .from('course_folder_assignments').select('course_id').eq('folder_id', folderId).maybeSingle();
      if (!assign) return res.status(404).json({ error: 'Uploads-map is niet aan een cursus gekoppeld' });
      const courseId = assign.course_id;

      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      const isCourseStaff = isAdmin
        || (await isCourseTeacher(auth.user.id, courseId));
      if (!isCourseStaff) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });

      const { data: projects } = await supabaseAdmin
        .from('projects').select('id, title').eq('course_id', courseId);
      const projectIds = (projects || []).map(p => p.id);
      if (!projectIds.length) return res.json({ courseId, submissions: [] });
      const projectMap = new Map((projects || []).map(p => [p.id, p]));

      const { data: rows, error: e } = await supabaseAdmin
        .from('project_submissions')
        .select('id, project_id, group_id, uploaded_by, filename, mime_type, byte_size, created_at, project_groups!inner(name)')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false });
      if (e) return res.status(500).json({ error: e.message });

      const uploaderIds = Array.from(new Set((rows || []).map(r => r.uploaded_by).filter(Boolean)));
      let uploaderMap = new Map();
      if (uploaderIds.length) {
        const { data: profs } = await supabaseAdmin
          .from('profiles').select('id, email, full_name').in('id', uploaderIds);
        uploaderMap = new Map((profs || []).map(p => [p.id, p]));
      }
      return res.json({
        courseId,
        submissions: (rows || []).map(s => {
          const up = s.uploaded_by ? uploaderMap.get(s.uploaded_by) : null;
          const proj = projectMap.get(s.project_id);
          return {
            id: s.id,
            project_id: s.project_id,
            project_title: proj?.title || null,
            group_id: s.group_id,
            group_name: s.project_groups?.name || null,
            uploaded_by: s.uploaded_by,
            uploaded_by_name: up?.full_name || up?.email || null,
            uploaded_by_email: up?.email || null,
            filename: s.filename,
            mime_type: s.mime_type,
            byte_size: s.byte_size,
            created_at: s.created_at,
          };
        }),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
