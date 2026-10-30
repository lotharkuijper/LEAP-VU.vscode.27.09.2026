import { promoteCourseTeacherProfile } from './teacherProfile.js';
import { dedupeEmails, extractEmails } from './bulkAccounts.js';
import { authorizeAvailabilityChange, parseStudentVisible } from './courseAvailability.js';
import {
  explainPartsValid,
  mergeCourseFeatures,
  normalizeCourseFeatures,
  parseCourseFeaturesPatch,
} from './courseFeatures.js';
import { registerCourseInfoRoutes } from './courseInfo.js';
import { pendingInvitationsForCourse, registerCourseInvitationRoutes } from './courseInvitations.js';
import { collectMemberUserIds, mergeCourseMembers, sortCourseMembers } from './courseMembers.js';
import { registerCourseUnitRoutes } from './courseUnits.js';
import { LEVEL_DEFAULT, LEVEL_LABELS, LEVEL_MAX, LEVEL_MIN } from '../chat/learningLevel.js';
import {
  authUser,
  isCourseTeacher,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  resolveAdminUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import { courseMaterialDocuments, leerlijnCache, logSettingChange } from '../lib/courseData.js';
import { courseFeaturesCache } from '../lib/courseFeatureGate.js';
import { SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import { TURN_SECRET } from '../lib/turnSigning.js';
import { docUpload, extractTextFromUpload, getFileMimeType } from '../lib/uploads.js';
import {
  authorizeMemberRoleChange,
  checkLastTeacherProtection,
  parseForceFlag,
} from './memberRoleAuth.js';
import { getEmailConfig, sendEmail } from '../lib/notifications.js';

// Helper — gemeenschappelijk voor admin- en self-endpoint hieronder.
async function fetchTeacherCoursesForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('course_members')
    .select('course_id, courses(id, name, is_active)')
    .eq('user_id', userId)
    .eq('member_role', 'teacher');
  if (error) throw new Error(error.message);
  return (data || [])
    .map((row) => ({
      courseId: row.course_id,
      courseName: row.courses?.name || null,
      isActive: row.courses?.is_active ?? null,
    }))
    .filter((c) => c.courseName) // verwijderde cursussen weglaten
    .sort((a, b) => (a.courseName || '').localeCompare(b.courseName || '', 'nl'));
}

export function registerCourseRoutes(app) {
  // ───────────────────────────────────────────────────────────────────────────
  // Cursus-info (Task #202/#203) — de 7 endpoints staan in ./courseInfo.js zodat
  // hun toegangsregels geautomatiseerd getest kunnen worden via dependency-
  // injectie. Afhankelijkheden (Supabase, pg, auth-helpers, multer) gaan via deps.
  // ───────────────────────────────────────────────────────────────────────────
  registerCourseInfoRoutes(app, {
    supabaseAdmin,
    pgPool,
    getFileMimeType,
    requireAuthUser,
    userHasCourseAccess,
    isStaffForCourse,
    docUpload,
  });

  // POST /api/admin/courses — maak een nieuwe cursus aan met bijhorende
  // parent-map ({naam}), RAG-submap en Projectdata-submap (analoog aan MenS1).
  app.post('/api/admin/courses', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen aanmaken' });

    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!rawName) return res.status(400).json({ error: 'Cursusnaam is verplicht' });
    if (rawName.length > 120) return res.status(400).json({ error: 'Cursusnaam is te lang (max 120 tekens)' });

    // Houd aangemaakte ID's bij zodat we bij een mislukking netjes kunnen opruimen
    // (Supabase JS-client kent geen multi-statement transacties).
    const createdFolderIds = [];
    let createdCourseId = null;

    const rollback = async (reason) => {
      console.warn(`[admin/courses] Rolling back na fout: ${reason}`);
      for (const fid of [...createdFolderIds].reverse()) {
        try { await supabaseAdmin.from('document_folders').delete().eq('id', fid); }
        catch (e) { console.warn('[admin/courses] rollback folder fout (genegeerd):', e?.message); }
      }
      if (createdCourseId) {
        try { await supabaseAdmin.from('courses').delete().eq('id', createdCourseId); }
        catch (e) { console.warn('[admin/courses] rollback course fout (genegeerd):', e?.message); }
      }
    };

    try {
      // 1) Voorkom dubbele cursusnaam OF dubbele folder_name (beide kolommen
      //    hebben een UNIQUE-constraint en zijn in onze flow altijd gelijk).
      //    We doen twee aparte gelijkheidsqueries i.p.v. .or() met string-
      //    interpolatie, omdat namen leestekens kunnen bevatten die de
      //    PostgREST-or-filter zouden breken. Een unieke index garandeert
      //    bovendien dat 23505 onder een race-conditie altijd opgevangen wordt.
      const [{ data: clashByName }, { data: clashByFolder }] = await Promise.all([
        supabaseAdmin.from('courses').select('id').eq('name', rawName).maybeSingle(),
        supabaseAdmin.from('courses').select('id').eq('folder_name', rawName).maybeSingle(),
      ]);
      if (clashByName || clashByFolder) {
        return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${rawName}"` });
      }

      // 2) Zoek de globale root-map (is_root=true). Nodig voor de parent-map.
      const { data: rootFolder, error: rootErr } = await supabaseAdmin
        .from('document_folders').select('id').eq('is_root', true).limit(1).maybeSingle();
      if (rootErr || !rootFolder) {
        return res.status(500).json({ error: 'Globale root-map (is_root=true) niet gevonden' });
      }

      // 3) Maak de cursus aan. courses.folder_name is NOT NULL UNIQUE en wordt
      //    altijd gelijkgehouden aan courses.name (zo zijn MenS1 en Basiscursus
      //    ook aangemaakt). Sync-tooling (src/services/courseSync.ts) gebruikt
      //    folder_name om met Supabase Storage-rootmappen te vergelijken.
      const { data: newCourse, error: courseErr } = await supabaseAdmin
        .from('courses')
        .insert({
          name: rawName,
          folder_name: rawName,
          description: description || null,
          is_active: true,
        })
        .select('id, name, folder_name, description, is_active')
        .single();
      if (courseErr || !newCourse) {
        // 23505 = unique_violation — race-conditie tussen pre-check en insert.
        if (courseErr && (courseErr.code === '23505' || /duplicate key/i.test(courseErr.message || ''))) {
          return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${rawName}"` });
        }
        return res.status(500).json({ error: `Kon cursus niet aanmaken: ${courseErr?.message}` });
      }
      createdCourseId = newCourse.id;

      const insertPerms = async (folderId) => {
        const { error } = await supabaseAdmin.from('folder_permissions').insert([
          { folder_id: folderId, role: 'admin',   can_view: true, can_edit: true },
          { folder_id: folderId, role: 'docent',  can_view: true, can_edit: true },
          { folder_id: folderId, role: 'student', can_view: true, can_edit: false },
        ]);
        if (error) throw new Error(`folder_permissions insert mislukt voor ${folderId}: ${error.message}`);
      };

      // 4) Parent-cursusmap onder root.
      const { data: courseFolder, error: cfErr } = await supabaseAdmin
        .from('document_folders').insert({
          name: rawName,
          description: `Cursusmap ${rawName}`,
          parent_folder_id: rootFolder.id,
          created_by: r.user.id,
          folder_type: 'course',
          is_root: false,
        }).select('id').single();
      if (cfErr || !courseFolder) {
        await rollback(`cursusmap-insert: ${cfErr?.message}`);
        return res.status(500).json({ error: `Kon cursusmap niet aanmaken: ${cfErr?.message}` });
      }
      createdFolderIds.push(courseFolder.id);
      await insertPerms(courseFolder.id);

      // 5) RAG-submap.
      const { data: ragFolder, error: ragErr } = await supabaseAdmin
        .from('document_folders').insert({
          name: 'RAG',
          description: `RAG-documenten voor ${rawName}`,
          parent_folder_id: courseFolder.id,
          created_by: r.user.id,
          folder_type: 'rag_sources',
          is_root: false,
        }).select('id').single();
      if (ragErr || !ragFolder) {
        await rollback(`rag-folder-insert: ${ragErr?.message}`);
        return res.status(500).json({ error: `Kon RAG-map niet aanmaken: ${ragErr?.message}` });
      }
      createdFolderIds.push(ragFolder.id);
      await insertPerms(ragFolder.id);

      // 6) Projectdata-submap.
      const { data: dataFolder, error: dataErr } = await supabaseAdmin
        .from('document_folders').insert({
          name: 'Projectdata',
          description: `Projectbestanden voor ${rawName}`,
          parent_folder_id: courseFolder.id,
          created_by: r.user.id,
          folder_type: 'data',
          is_root: false,
        }).select('id').single();
      if (dataErr || !dataFolder) {
        await rollback(`projectdata-folder-insert: ${dataErr?.message}`);
        return res.status(500).json({ error: `Kon Projectdata-map niet aanmaken: ${dataErr?.message}` });
      }
      createdFolderIds.push(dataFolder.id);
      await insertPerms(dataFolder.id);

      // 6b) Uploads-submap voor studenten-inleveringen (Task #156).
      const { data: uploadsFolder, error: upErr } = await supabaseAdmin
        .from('document_folders').insert({
          name: 'Uploads',
          description: `Inleveringen voor ${rawName}`,
          parent_folder_id: courseFolder.id,
          created_by: r.user.id,
          folder_type: 'uploads',
          bucket_type: 'docs_general',
          is_root: false,
        }).select('id').single();
      if (upErr || !uploadsFolder) {
        await rollback(`uploads-folder-insert: ${upErr?.message}`);
        return res.status(500).json({ error: `Kon Uploads-map niet aanmaken: ${upErr?.message}` });
      }
      createdFolderIds.push(uploadsFolder.id);
      await insertPerms(uploadsFolder.id);

      // 7) Koppel beide submappen aan de cursus (verplicht — anders zien cursus en mappen elkaar niet).
      const { error: assignErr } = await supabaseAdmin
        .from('course_folder_assignments').insert([
          { course_id: createdCourseId, folder_id: ragFolder.id },
          { course_id: createdCourseId, folder_id: dataFolder.id },
          { course_id: createdCourseId, folder_id: uploadsFolder.id },
        ]);
      if (assignErr) {
        await rollback(`course_folder_assignments: ${assignErr.message}`);
        return res.status(500).json({ error: `Kon mappen niet koppelen aan cursus: ${assignErr.message}` });
      }

      // 8) Activeer RAG-modules voor de RAG-map (analoog aan MenS1). Niet-fataal.
      const { error: ragAssignErr } = await supabaseAdmin
        .from('folder_rag_assignments').insert([
          { folder_id: ragFolder.id, module_type: 'general', is_active: true },
          { folder_id: ragFolder.id, module_type: 'explain', is_active: true },
          { folder_id: ragFolder.id, module_type: 'quiz',    is_active: true },
        ]);
      if (ragAssignErr) {
        console.warn('[admin/courses] folder_rag_assignments insert (non-fatal):', ragAssignErr.message);
      }

      console.log(`[admin/courses] Cursus "${rawName}" aangemaakt (${createdCourseId}) met folders ${courseFolder.id}/${ragFolder.id}/${dataFolder.id}/${uploadsFolder.id}`);
      return res.status(201).json({
        course: newCourse,
        courseFolderId: courseFolder.id,
        ragFolderId: ragFolder.id,
        projectdataFolderId: dataFolder.id,
        uploadsFolderId: uploadsFolder.id,
        ragModulesWarning: ragAssignErr ? ragAssignErr.message : null,
      });
    } catch (err) {
      console.error('[admin/courses] Unexpected error:', err);
      await rollback(`exception: ${err?.message}`);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // DELETE /api/admin/courses/:id/members — verwijder in één keer alle leden van
  // een cursus. Alleen voor admins. Bedoeld om de "cursus verwijderen"-flow te
  // deblokkeren wanneer er nog gekoppelde leden zijn.
  app.delete('/api/admin/courses/:id/members', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen leden bulk verwijderen' });

    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

    const { data: course, error: courseErr } = await supabaseAdmin
      .from('courses').select('id, name').eq('id', courseId).maybeSingle();
    if (courseErr) return res.status(500).json({ error: courseErr.message });
    if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });

    const { error: delErr, count } = await supabaseAdmin
      .from('course_members')
      .delete({ count: 'exact' })
      .eq('course_id', courseId);
    if (delErr) return res.status(500).json({ error: delErr.message });

    return res.json({ ok: true, removed: count ?? 0, course: { id: course.id, name: course.name } });
  });

  // GET /api/admin/courses/:id/members — lijst alle leden van een cursus met
  // hun member_role ('student'|'teacher'). Toegankelijk voor admin/superuser
  // en voor docenten van deze cursus. Joins met profiles voor weergave.
  app.get('/api/admin/courses/:id/members', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

    if (!r.isAdmin && !(await isCourseTeacher(r.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }

    // We joinen course_members hier NIET via een PostgREST-embed
    // (`profiles(...)`). course_members.user_id verwijst naar auth.users, niet
    // naar profiles, dus PostgREST kent geen directe relatie en geeft anders
    // "Could not find a relationship between 'course_members' and 'profiles'".
    // Daarom halen we eerst de leden op en daarna de bijbehorende profiles in
    // een tweede query, die we in JS samenvoegen (defensief, niet afhankelijk
    // van de schema-cache).
    const { data: rows, error } = await supabaseAdmin
      .from('course_members')
      .select('user_id, member_role')
      .eq('course_id', courseId);
    // course_members heeft geen joined_at (dat gaf een fout, 2026-10-26); sorteren gebeurt na het samenvoegen.
    if (error) return res.status(500).json({ error: error.message });

    const userIds = collectMemberUserIds(rows);
    let profs = [];
    if (userIds.length > 0) {
      const { data: profData, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, role')
        .in('id', userIds);
      if (profErr) return res.status(500).json({ error: profErr.message });
      profs = profData || [];
    }

    const members = sortCourseMembers(mergeCourseMembers(rows, profs));
    // Uitgenodigd maar nog niet geactiveerd (server/courses/courseInvitations.js).
    const pending = await pendingInvitationsForCourse(supabaseAdmin, courseId);
    for (const m of members) m.invitation = pending.get(m.user_id) || null;
    return res.json({ members });
  });

  // PUT /api/admin/courses/:id/members/:userId — wijzig de per-cursus rol
  // ('student' of 'teacher'). Toegestaan voor admin/superuser OF voor een
  // per-cursus docent van déze cursus (course_members.member_role='teacher').
  // Laatste-docent-bescherming: het demoten of verwijderen van de laatste
  // docent van een cursus geeft 409 zodat de cursus niet per ongeluk
  // docentloos achterblijft. Admins mogen forceren met query ?force=1.
  app.put('/api/admin/courses/:id/members/:userId', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const { id: courseId, userId } = req.params;
    const { member_role } = req.body || {};
    if (!courseId || !userId) return res.status(400).json({ error: 'Cursus-ID of user-ID ontbreekt' });
    if (member_role !== 'student' && member_role !== 'teacher') {
      return res.status(400).json({ error: 'member_role moet "student" of "teacher" zijn' });
    }

    // Autorisatie: admin OR per-cursus docent van déze cursus. Strikt
    // courseId-gescoped — een docent van een andere cursus krijgt 403.
    const callerIsCourseTeacher = r.isAdmin ? false : await isCourseTeacher(r.user.id, courseId);
    const authz = authorizeMemberRoleChange({ isAdmin: r.isAdmin, isCourseTeacher: callerIsCourseTeacher });
    if (!authz.allowed) return res.status(authz.status).json(authz.body);

    const force = parseForceFlag(req.query.force);

    // Atomair pad via pgPool — voorkomt een race waarbij twee gelijktijdige
    // demoties beide "count=2" zien en de cursus docentloos achterlaten. We
    // openen één transactie, locken álle teacher-rijen van de cursus met
    // FOR UPDATE, en pas dan tellen + updaten. Bij ontbreken van pgPool
    // valt de code terug op het oudere non-atomic pad (best-effort).
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        // Lock alle membership-rijen van deze cursus om concurrent demoties
        // te serialiseren. We hebben de hele set nodig om correct te tellen.
        const { rows: lockedRows } = await client.query(
          'SELECT user_id, member_role FROM course_members WHERE course_id = $1 FOR UPDATE',
          [courseId]
        );
        const existing = lockedRows.find((row) => row.user_id === userId);
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
        }
        const teacherCount = lockedRows.filter((row) => row.member_role === 'teacher').length;
        const guard = checkLastTeacherProtection({
          existingMemberRole: existing.member_role,
          newMemberRole: member_role,
          teacherCount,
          isAdmin: r.isAdmin,
          force,
        });
        if (!guard.ok) {
          await client.query('ROLLBACK');
          return res.status(guard.status).json(guard.body);
        }
        // Houd de legacy NOT NULL-kolom `role` in sync met member_role (behalve
        // voor superusers, waar role='superuser' bewaard blijft). Voorkomt dat
        // een demotie een role=teacher/member_role=student-drift achterlaat.
        await client.query(
          `UPDATE course_members
            SET member_role = $1,
                role = CASE WHEN role = 'superuser' THEN role ELSE $1 END
          WHERE course_id = $2 AND user_id = $3`,
          [member_role, courseId, userId]
        );
        await client.query('COMMIT');
        // Ook op dit pad (live: directe databaseverbinding) het docentprofiel zetten.
        const profileRole = member_role === 'teacher' ? await promoteCourseTeacherProfile(userId, r.user?.id, courseId) : null;
        return res.json({ ok: true, user_id: userId, course_id: courseId, member_role, ...(profileRole ? { profileRole } : {}) });
      } catch (txErr) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('[admin members PUT] tx error', txErr.message);
        return res.status(500).json({ error: txErr.message });
      } finally {
        client.release();
      }
    }

    // Fallback zonder directe DB-verbinding (best-effort, niet race-safe).
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('course_members')
      .select('member_role, role')
      .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
    {
      const { count, error: cntErr } = await supabaseAdmin
        .from('course_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('course_id', courseId)
        .eq('member_role', 'teacher');
      if (cntErr) return res.status(500).json({ error: cntErr.message });
      const guard = checkLastTeacherProtection({
        existingMemberRole: existing.member_role,
        newMemberRole: member_role,
        teacherCount: count || 0,
        isAdmin: r.isAdmin,
        force,
      });
      if (!guard.ok) return res.status(guard.status).json(guard.body);
    }
    // Spiegel member_role naar de legacy `role`-kolom (superuser blijft superuser).
    const nextLegacyRole = existing.role === 'superuser' ? 'superuser' : member_role;
    const { error: updErr } = await supabaseAdmin
      .from('course_members')
      .update({ member_role, role: nextLegacyRole })
      .eq('course_id', courseId)
      .eq('user_id', userId);
    if (updErr) return res.status(500).json({ error: updErr.message });
    const profileRole = member_role === 'teacher' ? await promoteCourseTeacherProfile(userId, r.user?.id, courseId) : null;
    return res.json({ ok: true, user_id: userId, course_id: courseId, member_role, ...(profileRole ? { profileRole } : {}) });
  });

  // DELETE /api/admin/courses/:id/members/:userId — verwijder één lid uit een
  // cursus. Toegestaan voor admin/superuser OF voor een per-cursus docent van
  // déze cursus (course_members.member_role='teacher'). Strikt courseId-gescoped.
  // Last-teacher-bescherming: de laatste docent kan niet zomaar verwijderd
  // worden (409, code 'last_teacher') tenzij een admin ?force=1 meestuurt.
  app.delete('/api/admin/courses/:id/members/:userId', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const { id: courseId, userId } = req.params;
    if (!courseId || !userId) return res.status(400).json({ error: 'Cursus-ID of user-ID ontbreekt' });

    // Autorisatie: admin OR per-cursus docent van déze cursus.
    const callerIsCourseTeacher = r.isAdmin ? false : await isCourseTeacher(r.user.id, courseId);
    const authz = authorizeMemberRoleChange({ isAdmin: r.isAdmin, isCourseTeacher: callerIsCourseTeacher });
    if (!authz.allowed) return res.status(authz.status).json(authz.body);

    const force = parseForceFlag(req.query.force);

    // Atomair pad via pgPool — lock alle membership-rijen, tel docenten,
    // pas last-teacher-bescherming toe en verwijder pas dan. Een docent
    // verwijderen telt als demotie (teacher → weg) voor de bescherming.
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const { rows: lockedRows } = await client.query(
          'SELECT user_id, member_role FROM course_members WHERE course_id = $1 FOR UPDATE',
          [courseId]
        );
        const existing = lockedRows.find((row) => row.user_id === userId);
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
        }
        const teacherCount = lockedRows.filter((row) => row.member_role === 'teacher').length;
        const guard = checkLastTeacherProtection({
          existingMemberRole: existing.member_role,
          newMemberRole: 'student',
          teacherCount,
          isAdmin: r.isAdmin,
          force,
        });
        if (!guard.ok) {
          await client.query('ROLLBACK');
          return res.status(guard.status).json(guard.body);
        }
        await client.query(
          'DELETE FROM course_members WHERE course_id = $1 AND user_id = $2',
          [courseId, userId]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, user_id: userId, course_id: courseId, removed: true });
      } catch (txErr) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('[admin members DELETE] tx error', txErr.message);
        return res.status(500).json({ error: txErr.message });
      } finally {
        client.release();
      }
    }

    // Fallback zonder directe DB-verbinding (best-effort, niet race-safe).
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('course_members')
      .select('member_role')
      .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: 'Lid niet gevonden in deze cursus' });
    {
      const { count, error: cntErr } = await supabaseAdmin
        .from('course_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('course_id', courseId)
        .eq('member_role', 'teacher');
      if (cntErr) return res.status(500).json({ error: cntErr.message });
      const guard = checkLastTeacherProtection({
        existingMemberRole: existing.member_role,
        newMemberRole: 'student',
        teacherCount: count || 0,
        isAdmin: r.isAdmin,
        force,
      });
      if (!guard.ok) return res.status(guard.status).json(guard.body);
    }
    const { error: delErr } = await supabaseAdmin
      .from('course_members')
      .delete()
      .eq('course_id', courseId)
      .eq('user_id', userId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.json({ ok: true, user_id: userId, course_id: courseId, removed: true });
  });

  // POST /api/admin/courses/:id/members/:userId — voeg een gebruiker toe aan
  // een cursus met een gegeven member_role ('student' of 'teacher'). Idempotent:
  // als de gebruiker al lid is, wordt diens member_role bijgewerkt (handig om
  // vanuit /admin → Gebruikers iemand direct als docent toe te voegen aan een
  // cursus). Toegestaan voor admin/superuser OF voor een per-cursus docent van
  // déze cursus (course_members.member_role='teacher'). Strikt courseId-gescoped:
  // een docent van een andere cursus krijgt 403.
  app.post('/api/admin/courses/:id/members/:userId', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const { id: courseId, userId } = req.params;
    const { member_role } = req.body || {};
    if (!courseId || !userId) return res.status(400).json({ error: 'Cursus-ID of user-ID ontbreekt' });
    // Autorisatie: admin OR per-cursus docent van déze cursus (zelfde helper als
    // de PUT/DELETE-varianten). Strikt courseId-gescoped.
    const callerIsCourseTeacher = r.isAdmin ? false : await isCourseTeacher(r.user.id, courseId);
    const authz = authorizeMemberRoleChange({ isAdmin: r.isAdmin, isCourseTeacher: callerIsCourseTeacher });
    if (!authz.allowed) return res.status(authz.status).json(authz.body);
    // Dit endpoint is bedoeld om iemand als docent (of student) toe te voegen.
    // Demoties van bestaande docenten lopen via PUT (met last-teacher-bescherming);
    // hier laten we daarom een bestaande teacher-rol NOOIT door dit endpoint
    // omlaag worden gezet, zodat de invariant "elke cursus houdt minstens één
    // docent" niet via een upsert kan worden omzeild.
    if (member_role !== 'student' && member_role !== 'teacher') {
      return res.status(400).json({ error: 'member_role moet "student" of "teacher" zijn' });
    }
    try {
      const { data: course } = await supabaseAdmin
        .from('courses').select('id').eq('id', courseId).maybeSingle();
      if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });
      const { data: prof } = await supabaseAdmin
        .from('profiles').select('id').eq('id', userId).maybeSingle();
      if (!prof) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      const { data: existing } = await supabaseAdmin
        .from('course_members')
        .select('member_role, role')
        .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
      if (existing && existing.member_role === 'teacher' && member_role === 'student') {
        return res.status(409).json({
          error: 'Gebruik PUT /api/admin/courses/:id/members/:userId om een docent te degraderen (last-teacher-bescherming).',
          code: 'use_put_for_demotion',
        });
      }
      // course_members.role is een legacy NOT NULL kolom met CHECK
      // (role IN ('superuser','teacher','student')). We spiegelen member_role
      // expliciet zodat upserts ook werken in omgevingen waar migratie
      // 20260527220000 (default 'student') nog niet is toegepast.
      // Behoud een bestaande superuser-rol: superusers staan als role='superuser'
      // met member_role='student'; die mag een gewone toevoeging niet overschrijven.
      const nextLegacyRole = existing && existing.role === 'superuser' ? 'superuser' : member_role;
      const { error: upErr } = await supabaseAdmin
        .from('course_members')
        .upsert(
          { course_id: courseId, user_id: userId, member_role, role: nextLegacyRole },
          { onConflict: 'course_id,user_id' }
        );
      if (upErr) return res.status(500).json({ error: upErr.message });
      const profileRole = member_role === 'teacher' ? await promoteCourseTeacherProfile(userId, r.user?.id, courseId) : null;
      return res.json({ ok: true, user_id: userId, course_id: courseId, member_role, ...(profileRole ? { profileRole } : {}) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/users/:userId/teacher-courses — admin-only. Gebruikt door
  // de /admin Gebruikers-tab om per gebruiker te tonen in welke cursussen
  // zij/hij docent is. Niet-admins krijgen 403 (zij gebruiken /api/me/...).
  app.get('/api/admin/users/:userId/teacher-courses', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'user-ID ontbreekt' });
    if (!r.isAdmin) {
      return res.status(403).json({ error: 'Alleen admins mogen andermans docent-cursussen opvragen' });
    }
    try {
      const courses = await fetchTeacherCoursesForUser(userId);
      return res.json({ courses });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/admin/users/:userId — admin-only. Verwijdert een gebruiker
  // definitief via de Supabase service-role admin-API. Dit verwijdert de rij in
  // auth.users, wat cascadeert naar profiles (ON DELETE CASCADE) en gerelateerde
  // tabellen. Het e-mailadres komt daarmee weer vrij voor een nieuwe registratie.
  // De eigen account en de superuser kunnen niet verwijderd worden.
  app.delete('/api/admin/users/:userId', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) {
      return res.status(403).json({ error: 'Alleen admins mogen gebruikers verwijderen' });
    }
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'user-ID ontbreekt' });

    if (userId === r.user.id) {
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
    }

    try {
      // Doelprofiel ophalen om superuser-beveiliging te kunnen afdwingen.
      const { data: targetProfile } = await supabaseAdmin
        .from('profiles').select('id, email').eq('id', userId).maybeSingle();

      if (targetProfile?.email === SUPERUSER_EMAIL) {
        return res.status(400).json({ error: 'De superuser kan niet verwijderd worden' });
      }

      const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteErr) {
        if (/not found/i.test(deleteErr.message || '')) {
          return res.status(404).json({ error: 'Gebruiker niet gevonden' });
        }
        throw new Error(deleteErr.message);
      }

      console.log(`[admin DELETE user] Removed user=${userId} by admin=${r.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[admin DELETE user] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/me/teacher-courses — geeft de ingelogde gebruiker de lijst
  // cursussen waarin zij/hij per-cursus docent is. Wordt door CoursesAdmin
  // gebruikt om de 'Beheer leden'-knop te tonen voor non-admin docenten.
  app.get('/api/me/teacher-courses', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    try {
      const courses = await fetchTeacherCoursesForUser(r.user.id);
      return res.json({ courses });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Bulk-accounts (Task #271): e-mailadressen uit een bestand halen. Uitnodigen zelf: server/courses/courseInvitations.js.
  // POST /api/admin/bulk-accounts/parse-file — leest een geüpload bestand
  // (.csv/.txt of office-formaat .xlsx/.docx/.pdf/…) en vist er e-mailadressen uit.
  // Alleen voor staff (admin of docent ergens). Geeft een ontdubbelde lijst terug;
  // de client laat de docent de lijst nog nakijken vóór het echte aanmaken.
  app.post('/api/admin/bulk-accounts/parse-file', docUpload.single('file'), async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin && !r.isDocent) {
      return res.status(403).json({ error: 'Alleen docent of admin mag bestanden inlezen' });
    }
    if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
    let text = '';
    try {
      text = await extractTextFromUpload(req.file);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' });
    }
    const emails = dedupeEmails(extractEmails(text));
    return res.json({ emails, count: emails.length });
  });

  // PATCH /api/admin/courses/:id — hernoem en/of werk beschrijving bij van een
  // bestaande cursus. Houdt courses.name, courses.folder_name én de parent-
  // cursusmap-naam in document_folders synchroon, zodat de structuur identiek
  // blijft aan MenS1/Basiscursus.
  app.patch('/api/admin/courses/:id', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen bewerken' });

    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

    const nameProvided = typeof req.body?.name === 'string';
    const descProvided = typeof req.body?.description === 'string';
    const activeProvided = typeof req.body?.is_active === 'boolean';
    const cueProvided = req.body?.cue_delta_max !== undefined;
    if (!nameProvided && !descProvided && !activeProvided && !cueProvided) {
      return res.status(400).json({ error: 'Geef minstens "name", "description", "is_active" of "cue_delta_max" mee' });
    }

    const newName = nameProvided ? req.body.name.trim() : null;
    const newDesc = descProvided ? req.body.description.trim() : null;
    const newActive = activeProvided ? req.body.is_active : null;
    let newCueMax = null;
    if (cueProvided) {
      const raw = Number(req.body.cue_delta_max);
      if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > 5) {
        return res.status(400).json({ error: 'cue_delta_max moet een geheel getal tussen 1 en 5 zijn' });
      }
      newCueMax = raw;
    }
    if (nameProvided) {
      if (!newName) return res.status(400).json({ error: 'Cursusnaam mag niet leeg zijn' });
      if (newName.length > 120) return res.status(400).json({ error: 'Cursusnaam is te lang (max 120 tekens)' });
    }

    // We voeren de wijzigingen uit binnen één Postgres-transactie via pgPool,
    // zodat een mislukte folder-rename de courses-update ook terugdraait. De
    // supabase-js client heeft geen transactiesupport, vandaar deze route.
    if (!pgPool) {
      return res.status(503).json({ error: 'Direct DB-verbinding (SUPABASE_DB_URL) niet beschikbaar voor transactionele rename' });
    }

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // 1) Bestaande cursus ophalen + row-lock.
      const existingRes = await client.query(
        'SELECT id, name, folder_name, description FROM courses WHERE id = $1 FOR UPDATE',
        [courseId]
      );
      if (existingRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Cursus niet gevonden' });
      }
      const existing = existingRes.rows[0];

      // 2) Bij naamwijziging: uniekheid op name én folder_name (excl. zichzelf).
      if (nameProvided && newName !== existing.name) {
        const clashRes = await client.query(
          `SELECT id FROM courses
         WHERE id <> $1 AND (name = $2 OR folder_name = $2)
         LIMIT 1`,
          [courseId, newName]
        );
        if (clashRes.rowCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Er bestaat al een cursus met de naam "${newName}"` });
        }
      }

      // 3) courses-rij bijwerken. name én folder_name blijven gelijk.
      const setParts = [];
      const params = [];
      let i = 1;
      if (nameProvided) {
        setParts.push(`name = $${i++}`);
        params.push(newName);
        setParts.push(`folder_name = $${i++}`);
        params.push(newName);
      }
      if (descProvided) {
        setParts.push(`description = $${i++}`);
        params.push(newDesc || null);
      }
      if (activeProvided) {
        setParts.push(`is_active = $${i++}`);
        params.push(newActive);
      }
      if (cueProvided) {
        setParts.push(`cue_delta_max = $${i++}`);
        params.push(newCueMax);
      }
      params.push(courseId);
      let updRes;
      try {
        updRes = await client.query(
          `UPDATE courses SET ${setParts.join(', ')}
         WHERE id = $${i}
         RETURNING id, name, folder_name, description, is_active`,
          params
        );
      } catch (uErr) {
        // Defensief: oude DB zonder cue_delta_max-kolom → opnieuw zonder dat veld.
        if (cueProvided && (uErr.code === '42703' || /cue_delta_max/i.test(uErr.message || ''))) {
          await client.query('ROLLBACK');
          return res.status(503).json({ error: 'cue_delta_max-kolom ontbreekt in deze database — pas de migratie eerst toe.' });
        }
        throw uErr;
      }
      const updated = updRes.rows[0];

      // 4) Bij naamwijziging: parent-cursusmap synchroon hernoemen. De map is
      //    eenduidig identificeerbaar als (parent_folder_id = root, folder_type
      //    = 'course', name = oude cursusnaam) — er bestaat een UNIQUE-
      //    constraint op (parent_folder_id, name) in document_folders. Wij
      //    eisen exact 1 geüpdatete rij; bij 0 of meer dan 1 rollback.
      if (nameProvided && newName !== existing.name) {
        const rootRes = await client.query(
          "SELECT id FROM document_folders WHERE is_root = true LIMIT 1"
        );
        if (rootRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Globale root-map (is_root=true) niet gevonden — rename teruggedraaid' });
        }
        const rootId = rootRes.rows[0].id;
        const folderRes = await client.query(
          `UPDATE document_folders
         SET name = $1, description = $2
         WHERE parent_folder_id = $3
           AND folder_type = 'course'
           AND name = $4
         RETURNING id`,
          [newName, `Cursusmap ${newName}`, rootId, existing.name]
        );
        if (folderRes.rowCount !== 1) {
          await client.query('ROLLBACK');
          return res.status(500).json({
            error: `Verwacht 1 cursusmap te hernoemen, maar vond er ${folderRes.rowCount}. Wijziging teruggedraaid.`,
          });
        }
      }

      await client.query('COMMIT');
      console.log(`[admin/courses] Cursus ${courseId} bijgewerkt → name="${updated.name}"`);
      return res.json({ course: updated });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      // unique_violation = 23505 (mocht race-conditie er toch doorheen glippen)
      if (err && err.code === '23505') {
        return res.status(409).json({ error: `Naam is al in gebruik door een andere cursus` });
      }
      console.error('[admin/courses PATCH] Unexpected error:', err);
      return res.status(500).json({ error: err?.message || 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // PATCH /api/courses/:id/availability — zet een cursus op beschikbaar/niet
  // beschikbaar voor studenten (Task #270). Anders dan PATCH /api/admin/courses
  // (admin-only, transactioneel over meerdere velden) mag hier óók de docent van
  // déze cursus de zichtbaarheid wijzigen. We gaten met requireAuthUser + de pure
  // authorizeAvailabilityChange-helper (admin OF per-cursus docent). De admin-
  // PATCH blijft expres ongemoeid zodat die admin-only contract houdt.
  app.patch('/api/courses/:id/availability', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

    const parsed = parseStudentVisible(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

    const isAdmin = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
    const teacher = isAdmin ? false : await isCourseTeacher(auth.user.id, courseId);
    const decision = authorizeAvailabilityChange({ isAdmin, isCourseTeacher: teacher });
    if (!decision.allowed) return res.status(decision.status).json(decision.body);

    try {
      const { data, error } = await supabaseAdmin
        .from('courses')
        .update({ student_visible: parsed.value })
        .eq('id', courseId)
        .select('id, name, is_active, student_visible')
        .maybeSingle();
      if (error) {
        // Defensief: oude DB zonder student_visible-kolom → duidelijke 503.
        if (error.code === '42703' || /student_visible/.test(error.message || '')) {
          return res.status(503).json({ error: 'student_visible-kolom ontbreekt in deze database — pas de migratie eerst toe.' });
        }
        console.error('[courses/availability PATCH] update error:', error);
        return res.status(500).json({ error: error.message || 'Bijwerken mislukt' });
      }
      if (!data) return res.status(404).json({ error: 'Cursus niet gevonden' });
      console.log(`[courses/availability] Cursus ${courseId} student_visible → ${parsed.value}`);
      return res.json({ course: data });
    } catch (err) {
      console.error('[courses/availability PATCH] Unexpected error:', err);
      return res.status(500).json({ error: err?.message || 'Internal server error' });
    }
  });

  // Onderdelen per cursus aan/uit (server/courses/courseFeatures.js). Zelfde rechten als
  // de beschikbaarheid: beheerder of docent van deze cursus. Body:
  // { features: { quiz: false, … } } — alleen de genoemde onderdelen veranderen.
  app.patch('/api/courses/:id/features', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });

    const parsed = parseCourseFeaturesPatch(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

    const isAdmin = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
    const teacher = isAdmin ? false : await isCourseTeacher(auth.user.id, courseId);
    const decision = authorizeAvailabilityChange({ isAdmin, isCourseTeacher: teacher });
    if (!decision.allowed) return res.status(403).json({ error: 'Alleen admin of docent van deze cursus mag de onderdelen wijzigen' });
    // Bijlagen in de chat aanzetten kan alleen na de dubbele bevestiging in het
    // beheer (waarschuwing gelezen + cursusnaam bevestigd).
    if (parsed.value.attachments === true && req.body?.confirmAttachments !== true) {
      return res.status(400).json({ error: 'Bevestig eerst dat je de waarschuwing over bijlagen hebt gelezen', code: 'confirm_required' });
    }

    try {
      const { data: current, error: readErr } = await supabaseAdmin
        .from('courses').select('features').eq('id', courseId).maybeSingle();
      if (readErr) {
        if (readErr.code === '42703' || /features/.test(readErr.message || '')) {
          return res.status(503).json({ error: 'De kolom courses.features ontbreekt — pas de migratie eerst toe.' });
        }
        return res.status(500).json({ error: readErr.message || 'Lezen mislukt' });
      }
      if (!current) return res.status(404).json({ error: 'Cursus niet gevonden' });
      const stored = mergeCourseFeatures(current.features, parsed.value);
      if (!explainPartsValid(stored)) {
        return res.status(400).json({ error: 'Laat minstens één onderdeel van Ik leg uit aan, of zet Ik leg uit helemaal uit', code: 'explainNeedsOnePart' });
      }
      const { error } = await supabaseAdmin.from('courses').update({ features: stored }).eq('id', courseId);
      if (error) return res.status(500).json({ error: error.message || 'Bijwerken mislukt' });
      courseFeaturesCache.delete(courseId);
      console.log(`[courses/features] Cursus ${courseId} opgeslagen: ${JSON.stringify(stored)}`);
      if ('attachments' in parsed.value
          && normalizeCourseFeatures(current.features).attachments !== parsed.value.attachments) {
        await logSettingChange({ courseId, setting: 'chat_attachments', value: { on: parsed.value.attachments }, changedBy: auth.user.id });
      }
      return res.json({ features: normalizeCourseFeatures(stored) });
    } catch (err) {
      console.error('[courses/features PATCH] Unexpected error:', err);
      return res.status(500).json({ error: err?.message || 'Internal server error' });
    }
  });

  // DELETE /api/admin/courses/:id — verwijder een cursus definitief. Alleen
  // toegestaan als er geen gekoppelde leden, projecten of extra mappen/documenten
  // zijn. De drie standaard-stub-folders (course/RAG/Projectdata) en hun
  // koppelingen (course_folder_assignments, folder_permissions,
  // folder_rag_assignments) worden in één transactie meeverwijderd.
  //
  // Query-parameters:
  //   ?preview=true  — voert geen delete uit, geeft alleen de tellingen terug.
  //   ?cascade=true  — verwijdert in één transactie ALLES dat aan de cursus
  //                    hangt (leden, projecten + hun sessies/threads/messages/
  //                    persona's/groep-data/checkpoints, dagboek-notities die
  //                    via source_ref aan de groepen/checkpoints hangen, en de
  //                    volledige cursusmap-subtree inclusief extra mappen en
  //                    documenten). Alleen voor admins, dubbele bevestiging
  //                    aan de client-kant.
  app.delete('/api/admin/courses/:id', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) return res.status(403).json({ error: 'Alleen admins kunnen cursussen verwijderen' });

    const courseId = req.params.id;
    if (!courseId) return res.status(400).json({ error: 'Cursus-ID ontbreekt' });
    if (!pgPool) {
      return res.status(503).json({ error: 'Direct DB-verbinding (SUPABASE_DB_URL) niet beschikbaar voor transactionele delete' });
    }

    const preview = req.query?.preview === 'true' || req.query?.preview === '1';
    const cascade = req.query?.cascade === 'true' || req.query?.cascade === '1';

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // 1) Cursus ophalen + row-lock.
      const existingRes = await client.query(
        'SELECT id, name FROM courses WHERE id = $1 FOR UPDATE',
        [courseId]
      );
      if (existingRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Cursus niet gevonden' });
      }
      const existing = existingRes.rows[0];

      // 2) Standaard course-folder + sub-folders identificeren (RAG / Projectdata).
      const rootRes = await client.query(
        "SELECT id FROM document_folders WHERE is_root = true LIMIT 1"
      );
      const rootId = rootRes.rowCount > 0 ? rootRes.rows[0].id : null;
      let courseFolderId = null;
      const subFolderIds = [];
      if (rootId) {
        const cfRes = await client.query(
          `SELECT id FROM document_folders
         WHERE parent_folder_id = $1 AND folder_type = 'course' AND name = $2
         LIMIT 1`,
          [rootId, existing.name]
        );
        if (cfRes.rowCount > 0) {
          courseFolderId = cfRes.rows[0].id;
          const subRes = await client.query(
            `SELECT id FROM document_folders
           WHERE parent_folder_id = $1
             AND folder_type IN ('rag_sources', 'data', 'uploads')
             AND name IN ('RAG', 'Projectdata', 'Uploads')`,
            [courseFolderId]
          );
          for (const row of subRes.rows) subFolderIds.push(row.id);
        }
      }
      const standardFolderIds = courseFolderId ? [courseFolderId, ...subFolderIds] : [];

      // 3) Tellingen van gekoppelde data die deletion zou blokkeren. We correleren
      //    sessies en journal-entries strikt aan deze cursus (via projects.course_id
      //    en via UUID-segmenten in learning_journal_entries.source_ref) zodat de
      //    tellingen niet per ongeluk globale rijen meenemen.
      const [
        membersRes,
        projectsRes,
        sessionsRes,
        journalRes,
        extraFoldersRes,
        docsRes,
        submissionsRes,
        uploadsDocsRes,
      ] = await Promise.all([
        client.query('SELECT COUNT(*)::int AS n FROM course_members WHERE course_id = $1', [courseId]),
        client.query('SELECT COUNT(*)::int AS n FROM projects WHERE course_id = $1', [courseId]),
        client.query(
          `SELECT COUNT(*)::int AS n
           FROM student_project_sessions sps
           JOIN projects p ON p.id = sps.project_id
          WHERE p.course_id = $1`,
          [courseId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n
           FROM learning_journal_entries lje
          WHERE lje.source_ref IS NOT NULL
            AND (
              (
                lje.source_ref LIKE 'group_evaluate:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT pg.id
                    FROM project_groups pg
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
              OR
              (
                lje.source_ref LIKE 'group_thread_checkpoint:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT cp.id
                    FROM group_checkpoints cp
                    JOIN project_groups pg ON pg.id = cp.group_id
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
            )`,
          [courseId]
        ),
        courseFolderId
          ? client.query(
              `WITH RECURSIVE subtree AS (
               SELECT id FROM document_folders WHERE id = $1
               UNION ALL
               SELECT df.id
                 FROM document_folders df
                 JOIN subtree s ON df.parent_folder_id = s.id
             )
             SELECT COUNT(*)::int AS n FROM subtree
              WHERE NOT (id = ANY($2::uuid[]))`,
              [courseFolderId, standardFolderIds]
            )
          : Promise.resolve({ rows: [{ n: 0 }] }),
        courseFolderId
          ? client.query(
              `WITH RECURSIVE subtree AS (
               SELECT id FROM document_folders WHERE id = $1
               UNION ALL
               SELECT df.id
                 FROM document_folders df
                 JOIN subtree s ON df.parent_folder_id = s.id
             )
             SELECT COUNT(*)::int AS n FROM documents
              WHERE folder_id IN (SELECT id FROM subtree)`,
              [courseFolderId]
            )
          : Promise.resolve({ rows: [{ n: 0 }] }),
        // Inleveringen (project_submissions) van alle projecten van deze cursus.
        client.query(
          `SELECT COUNT(*)::int AS n
           FROM project_submissions ps
           JOIN projects p ON p.id = ps.project_id
          WHERE p.course_id = $1`,
          [courseId]
        ),
        // Documenten specifiek in de Uploads-submap (aparte rapportage zodat de
        // delete-preview onderscheid kan maken tussen 'gewone' documenten en
        // uploads-documenten).
        courseFolderId
          ? client.query(
              `SELECT COUNT(*)::int AS n
               FROM documents d
               JOIN document_folders f ON f.id = d.folder_id
              WHERE f.parent_folder_id = $1
                AND f.folder_type = 'uploads'`,
              [courseFolderId]
            )
          : Promise.resolve({ rows: [{ n: 0 }] }),
      ]);

      const counts = {
        members: membersRes.rows[0].n,
        projects: projectsRes.rows[0].n,
        sessions: sessionsRes.rows[0].n,
        journal_entries: journalRes.rows[0].n,
        extra_folders: extraFoldersRes.rows[0].n,
        documents: docsRes.rows[0].n,
        submissions: submissionsRes.rows[0].n,
        uploadsDocuments: uploadsDocsRes?.rows?.[0]?.n ?? 0,
      };

      const blocked =
        counts.members > 0 ||
        counts.projects > 0 ||
        counts.sessions > 0 ||
        counts.journal_entries > 0 ||
        counts.extra_folders > 0 ||
        counts.documents > 0 ||
        counts.submissions > 0;

      // Preview-modus: alleen tellingen teruggeven, niets verwijderen.
      if (preview) {
        await client.query('ROLLBACK');
        return res.json({
          ok: true,
          preview: true,
          course: { id: existing.id, name: existing.name },
          counts,
        });
      }

      if (blocked && !cascade) {
        await client.query('ROLLBACK');
        const parts = [];
        if (counts.members > 0) parts.push(`${counts.members} lid/leden`);
        if (counts.projects > 0) parts.push(`${counts.projects} project(en)`);
        if (counts.sessions > 0) parts.push(`${counts.sessions} sessie(s)`);
        if (counts.journal_entries > 0) parts.push(`${counts.journal_entries} dagboek-notitie(s)`);
        if (counts.extra_folders > 0) parts.push(`${counts.extra_folders} extra (sub)map(pen)`);
        if (counts.documents > 0) parts.push(`${counts.documents} document(en)`);
        if (counts.submissions > 0) parts.push(`${counts.submissions} inlevering(en)`);
        return res.status(409).json({
          error: `Kan cursus "${existing.name}" niet verwijderen: er is nog gekoppelde data (${parts.join(', ')}). Verwijder die eerst of deactiveer de cursus.`,
          counts,
        });
      }

      // 3b) Cascade-modus: ruim eerst alle gekoppelde data op die niet via
      //     FK-cascades verdwijnt zodra de cursus weg is. Volgorde:
      //       a. learning_journal_entries (geen FK naar projects/courses;
      //          gekoppeld via source_ref) — alleen entries die strikt aan
      //          deze cursus hangen, identiek aan de counts-query hierboven.
      //       b. projects (cascade: project_personas, project_groups,
      //          project_group_members, group_chat_messages,
      //          group_persona_threads, group_persona_messages,
      //          group_checkpoints, project_documents,
      //          project_persona_documents, student_project_sessions,
      //          project_analyses).
      //       c. course_members (zou ook via courses-cascade gaan; expliciet
      //          zodat de teruggegeven 'deleted'-tellingen kloppen).
      //       d. documents in de hele cursusmap-subtree (documents.folder_id
      //          is ON DELETE SET NULL, dus zonder expliciete delete blijven
      //          ze als wezen achter).
      //       e. folder_permissions / folder_rag_assignments voor de hele
      //          subtree.
      //       f. document_folders subtree (top-folder verwijderen cascadet
      //          dankzij parent_folder_id ON DELETE CASCADE de rest mee).
      //       g. courses-rij (cascadet course_folder_assignments,
      //          quiz_sources/itembank-mapping/rag-mix-instellingen).
      let deleted = null;
      if (cascade && blocked) {
        // a. journal-notities verwijderen — exact dezelfde filter als de
        //    counts-query, zodat we niets meer of minder raken dan getoond.
        const journalDelRes = await client.query(
          `DELETE FROM learning_journal_entries lje
          WHERE lje.source_ref IS NOT NULL
            AND (
              (
                lje.source_ref LIKE 'group_evaluate:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT pg.id
                    FROM project_groups pg
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
              OR
              (
                lje.source_ref LIKE 'group_thread_checkpoint:%'
                AND split_part(lje.source_ref, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
                AND split_part(lje.source_ref, ':', 2)::uuid IN (
                  SELECT cp.id
                    FROM group_checkpoints cp
                    JOIN project_groups pg ON pg.id = cp.group_id
                    JOIN projects p ON p.id = pg.project_id
                   WHERE p.course_id = $1
                )
              )
            )`,
          [courseId]
        );

        // b. Projecten — cascadet alle project-sub-tabellen mee.
        const projectsDelRes = await client.query(
          'DELETE FROM projects WHERE course_id = $1',
          [courseId]
        );

        // c. Cursus-leden expliciet.
        const membersDelRes = await client.query(
          'DELETE FROM course_members WHERE course_id = $1',
          [courseId]
        );

        // d/e/f. Volledige folder-subtree onder de cursusmap.
        let documentsDeleted = 0;
        let extraFoldersDeleted = 0;
        if (courseFolderId) {
          // Documenten in elke folder onder de cursusmap.
          const docsDelRes = await client.query(
            `WITH RECURSIVE subtree AS (
             SELECT id FROM document_folders WHERE id = $1
             UNION ALL
             SELECT df.id
               FROM document_folders df
               JOIN subtree s ON df.parent_folder_id = s.id
           )
           DELETE FROM documents
            WHERE folder_id IN (SELECT id FROM subtree)`,
            [courseFolderId]
          );
          documentsDeleted = docsDelRes.rowCount || 0;

          // Aantal niet-standaard mappen tellen vóór de cascade-delete.
          const extraRes = await client.query(
            `WITH RECURSIVE subtree AS (
             SELECT id FROM document_folders WHERE id = $1
             UNION ALL
             SELECT df.id
               FROM document_folders df
               JOIN subtree s ON df.parent_folder_id = s.id
           )
           SELECT COUNT(*)::int AS n FROM subtree
            WHERE NOT (id = ANY($2::uuid[]))`,
            [courseFolderId, standardFolderIds]
          );
          extraFoldersDeleted = extraRes.rows[0].n;
        }

        // De expliciete folder-cleanup hieronder (course_folder_assignments,
        // folder_rag_assignments, folder_permissions en document_folders) is
        // gedeeld met het niet-cascade-pad en wordt zo dadelijk uitgevoerd.

        deleted = {
          journal_entries: journalDelRes.rowCount || 0,
          projects: projectsDelRes.rowCount || 0,
          members: membersDelRes.rowCount || 0,
          documents: documentsDeleted,
          extra_folders: extraFoldersDeleted,
          // project_submissions cascadet mee via projects ON DELETE CASCADE,
          // dus we rapporteren simpelweg de telling van vóór de delete.
          submissions: counts.submissions,
        };
      }

      // 4) Veilig opruimen: koppelingen → folders → cursus.
      //    course_folder_assignments cascadet via ON DELETE CASCADE op courses,
      //    maar we ruimen ze expliciet op zodat de folder-deletes daarna lukken
      //    zonder weeskoppelingen achter te laten.
      await client.query('DELETE FROM course_folder_assignments WHERE course_id = $1', [courseId]);

      if (subFolderIds.length > 0) {
        await client.query(
          'DELETE FROM folder_rag_assignments WHERE folder_id = ANY($1::uuid[])',
          [subFolderIds]
        );
      }
      if (standardFolderIds.length > 0) {
        await client.query(
          'DELETE FROM folder_permissions WHERE folder_id = ANY($1::uuid[])',
          [standardFolderIds]
        );
        // Eerst sub-folders, dan parent (FK-integriteit).
        if (subFolderIds.length > 0) {
          await client.query(
            'DELETE FROM document_folders WHERE id = ANY($1::uuid[])',
            [subFolderIds]
          );
        }
        if (courseFolderId) {
          await client.query('DELETE FROM document_folders WHERE id = $1', [courseFolderId]);
        }
      }

      const delRes = await client.query('DELETE FROM courses WHERE id = $1 RETURNING id', [courseId]);
      if (delRes.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Cursus-rij niet verwijderd (onverwachte rowCount)' });
      }

      await client.query('COMMIT');
      if (cascade && deleted) {
        console.log(
          `[admin/courses DELETE cascade] Cursus ${courseId} ("${existing.name}") verwijderd ` +
          `+ ${deleted.members} leden, ${deleted.projects} projecten, ${deleted.journal_entries} dagboek-notities, ` +
          `${deleted.documents} documenten, ${deleted.extra_folders} extra (sub)map(pen).`
        );
        return res.json({ ok: true, id: courseId, cascade: true, deleted });
      }
      console.log(`[admin/courses DELETE] Cursus ${courseId} ("${existing.name}") verwijderd.`);
      return res.json({ ok: true, id: courseId });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      console.error('[admin/courses DELETE] Unexpected error:', err);
      return res.status(500).json({ error: err?.message || 'Internal server error' });
    } finally {
      client.release();
    }
  });

  registerCourseInvitationRoutes(app, {
    supabaseAdmin,
    resolveAdminUser,
    isCourseTeacher,
    secret: TURN_SECRET,
    appUrl: () => process.env.APP_PUBLIC_URL || process.env.APP_BASE_URL || process.env.LTI_APP_URL || '',
    getEmailConfig,
    sendEmail,
    forgetUser: (id) => { userCache.forgetUser(id); profileCache.invalidate(id); },
    promoteTeacherProfile: promoteCourseTeacherProfile,
    startTimers: !process.env.VITEST,
  });

  registerCourseUnitRoutes(app, {
    supabaseAdmin, requireAuthUser, userHasCourseAccess, isStaffForCourse,
    courseMaterialDocuments, onChanged: (courseId) => leerlijnCache.delete(courseId),
  });

  // GET /api/admin/courses/:courseId/learning-levels — staff-inzicht (Task #297):
  // sinds 2026-10-08 (privacy) ALLEEN de verdeling over de niveaus, zonder namen:
  // een docent ziet niet welk niveau een individuele student kiest. READ-ONLY: docenten kunnen het niveau NIET wijzigen
  // (de student blijft de baas, kernprincipe van Task #296). Toegang via service-
  // role zodat de eigen-rij-RLS op student_course_levels niet versoepeld hoeft te
  // worden; gegate op admin/superuser of docent van déze cursus.
  app.get('/api/admin/courses/:courseId/learning-levels', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId } = req.params;
    const lang = String(req.query.lang || 'nl').toLowerCase() === 'nl' ? 'nl' : 'en';
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      const isCourseStaff = isAdmin || (await isCourseTeacher(auth.user.id, courseId));
      if (!isCourseStaff) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });

      const emptyDistribution = () => {
        const d = {};
        for (let l = LEVEL_MIN; l <= LEVEL_MAX; l++) d[l] = 0;
        return d;
      };

      const { data: rows, error: e } = await supabaseAdmin
        .from('student_course_levels')
        .select('user_id, level, updated_at')
        .eq('course_id', courseId)
        .order('updated_at', { ascending: false });
      if (e) {
        // Tabel ontbreekt nog (migratie niet uitgevoerd): geef leeg + waarschuwing
        // i.p.v. een 500, zodat het paneel netjes laadt op een oude DB.
        if (e.code === '42P01') {
          return res.json({
            levels: [],
            distribution: emptyDistribution(),
            total: 0,
            defaultLevel: LEVEL_DEFAULT,
            warning: 'student_course_levels ontbreekt — voer de migratie uit.',
          });
        }
        return res.status(500).json({ error: e.message });
      }

      const labels = LEVEL_LABELS[lang] || LEVEL_LABELS.nl;
      const distribution = emptyDistribution();
      for (const r of rows || []) {
        if (r.level >= LEVEL_MIN && r.level <= LEVEL_MAX) distribution[r.level] += 1;
      }
      return res.json({
        levels: [], // per student: bewust niet meer (privacy)
        labels,
        distribution,
        total: (rows || []).length,
        defaultLevel: LEVEL_DEFAULT,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
