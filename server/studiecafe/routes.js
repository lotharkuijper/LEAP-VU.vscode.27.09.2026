import { normalizeLang } from '../i18n/languages.js';
import { isStaffForCourse, requireAuthUser, userHasCourseAccess } from '../lib/auth.js';
import { courseFeatureOnFor } from '../lib/courseFeatureGate.js';
import { coursesHasStudentVisible } from '../lib/schemaFlags.js';
import { resolveAppBaseUrl } from '../lib/serverUrls.js';
import { SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import {
  buildDigestEmail,
  getEmailConfig,
  groupPendingByUser,
  normalizeNotificationPrefs,
  partitionByPrefs,
  sendEmail,
} from '../lib/notifications.js';
import { createOrphanCourseAccessCleanupRunner, registerStudiecafeRoutes } from './studiecafe.js';

// ── Studiecafé digest-worker (Task #311) ────────────────────────────────────
// Batcht de onverzonden meldingen uit studiecafe_notifications periodiek tot één
// e-mail per gebruiker. Respecteert de per-gebruiker opt-out (prefs): wie een
// soort melding uit heeft, krijgt die rijen NIET gemaild maar ze worden wel als
// verzonden gemarkeerd zodat ze niet eindeloos terugkomen. Faalt zacht: zonder
// geconfigureerde e-mail (Resend) blijft de wachtrij staan tot het wel kan.
export const DIGEST_INTERVAL_MS = Number(process.env.STUDIECAFE_DIGEST_INTERVAL_MS) || 300000;

const DIGEST_BATCH_LIMIT = 1000;

async function markNotificationsSent(ids) {
  if (!ids.length) return;
  try {
    await supabaseAdmin
      .from('studiecafe_notifications')
      .update({ sent_at: new Date().toISOString() })
      .in('id', ids);
  } catch (e) {
    console.warn('[studiecafe-digest] markeren als verzonden mislukt:', e.message);
  }
}

let digestRunning = false;

export async function runStudiecafeDigestOnce() {
  if (digestRunning) return;
  digestRunning = true;
  try {
    // 1. Haal onverzonden meldingen op.
    let pending;
    try {
      const { data, error } = await supabaseAdmin
        .from('studiecafe_notifications')
        .select('id, user_id, course_id, kind, thread_id, reply_id, actor_id, thread_title')
        .is('sent_at', null)
        .order('created_at', { ascending: true })
        .limit(DIGEST_BATCH_LIMIT);
      if (error) {
        // Ontbrekende tabel (oude DB) → stil overslaan.
        if (!/relation .* does not exist|schema cache/i.test(error.message || '')) {
          console.warn('[studiecafe-digest] ophalen mislukt:', error.message);
        }
        return;
      }
      pending = data || [];
    } catch (e) {
      console.warn('[studiecafe-digest] ophalen onverwacht:', e.message);
      return;
    }
    if (!pending.length) return;

    // 2. E-mail geconfigureerd? Zo niet: laat de wachtrij staan tot het wel kan.
    const emailCfg = await getEmailConfig();
    if (!emailCfg) {
      console.warn(
        `[studiecafe-digest] ${pending.length} melding(en) wachten, maar e-mail is niet geconfigureerd (ACS_CONNECTION_STRING of RESEND_API_KEY / Resend-connector). Wachtrij blijft staan.`,
      );
      return;
    }

    const baseUrl = resolveAppBaseUrl();
    const byUser = groupPendingByUser(pending);

    for (const [userId, rows] of byUser) {
      // 3. Voorkeuren laden + toepassen.
      let prefs = normalizeNotificationPrefs(null);
      try {
        const { data: prefRow } = await supabaseAdmin
          .from('studiecafe_notification_prefs')
          .select('email_replies, email_announcements')
          .eq('user_id', userId)
          .maybeSingle();
        prefs = normalizeNotificationPrefs(prefRow);
      } catch {
        /* default: alles aan */
      }
      const { allowed, suppressed } = partitionByPrefs(rows, prefs);

      // Onderdrukte meldingen meteen afvinken (niet mailen, niet herhalen).
      if (suppressed.length) await markNotificationsSent(suppressed.map((r) => r.id));
      if (!allowed.length) continue;

      // 4. E-mailadres + naam + taal van de ontvanger ophalen.
      let profile = null;
      try {
        const { data } = await supabaseAdmin
          .from('profiles')
          .select('email, full_name, preferred_lang')
          .eq('id', userId)
          .maybeSingle();
        profile = data;
      } catch {
        /* val terug op auth-email hieronder */
      }
      let email = profile && profile.email ? profile.email : null;
      if (!email) {
        try {
          const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
          email = authUser && authUser.user ? authUser.user.email : null;
        } catch {
          /* geen adres → overslaan, laat staan voor latere poging */
        }
      }
      if (!email) continue;

      const lang = normalizeLang(profile && profile.preferred_lang);
      const userName = (profile && profile.full_name && String(profile.full_name).split(' ')[0]) || '';

      // 5. Digest bouwen + versturen.
      const mail = buildDigestEmail(allowed, { userName, lang, baseUrl });
      if (!mail) {
        await markNotificationsSent(allowed.map((r) => r.id));
        continue;
      }
      const result = await sendEmail(emailCfg, {
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      if (result.ok) {
        await markNotificationsSent(allowed.map((r) => r.id));
      } else {
        console.warn(`[studiecafe-digest] verzenden mislukt (${email}): ${result.error}`);
        // Laat de rijen staan voor de volgende cyclus.
      }
    }
  } finally {
    digestRunning = false;
  }
}

// ── Studiecafé: opruimen van wees-toegangsrijen (Task #323 + #325) ──────────
// Een student verliest toegang tot een cursus wanneer die verborgen of
// gearchiveerd wordt (toegang is zichtbaarheids-gebaseerd, dus er is geen
// course_members-rij om op te cascaden). De ON DELETE CASCADE op course_id ruimt
// alleen op bij echte cursus-VERWIJDERING. Deze periodieke job verwijdert daarom
// per-(gebruiker, cursus)-rijen waarvan de gebruiker geen toegang meer heeft
// (gespiegeld op canAccessCourseContent), uit twee tabellen met dezelfde vorm:
//   - studiecafe_thread_reads (per-thread leesmarkeringen, Task #323);
//   - studiecafe_last_seen   (per-cursus zachte-uitrol-vloer, Task #325).
// Vereist pgPool (directe Postgres-verbinding) voor het set-gewijze NOT EXISTS-
// werk; zonder pgPool wordt de cyclus stil overgeslagen. Defensief: een
// ontbrekende tabel/kolom breekt niets af en stopt de andere tabel niet.
export const READS_CLEANUP_INTERVAL_MS = Number(process.env.STUDIECAFE_READS_CLEANUP_INTERVAL_MS) || 21600000;
 // 6 uur

// De fallback-logica (42703 → kolomloze SQL, 42P01 → stil overslaan), de
// pgPool=null no-op en de overlap-gate zitten in `createOrphanCourseAccessCleanupRunner`
// (server/studiecafe/studiecafe.js) zodat ze los van deze module-state getest kunnen worden.
// De getters leveren de actuele module-state (pgPool/coursesHasStudentVisible
// wijzigen pas na de startup-detectie).
export const runOrphanThreadReadsCleanupOnce = createOrphanCourseAccessCleanupRunner({
  getPgPool: () => pgPool,
  getHasStudentVisible: () => coursesHasStudentVisible,
  getSuperuserEmail: () => SUPERUSER_EMAIL,
});

export function registerStudiecafe(app) {
  // Studiecafé (Task #304) — per-cursus discussieforum. Alle schrijfacties lopen
  // via de service-role met userHasCourseAccess / isStaffForCourse als poortwachters;
  // SELECT-RLS (sc_can_read_course) spiegelt de zichtbaarheids-gebaseerde toegang.
  registerStudiecafeRoutes(app, {
    supabaseAdmin,
    requireAuthUser,
    // Studiecafé uit in deze cursus (server/courses/courseFeatures.js) = geen toegang,
    // behalve voor de docent en de beheerder.
    userHasCourseAccess: async (user, profile, courseId) =>
      (await userHasCourseAccess(user, profile, courseId))
      && (await courseFeatureOnFor(user, profile, courseId, 'studiecafe')),
    isStaffForCourse,
    pgPool,
  });
}
