// Privacy (2026-10-08): docenten zien niet wat studenten doen. Deze test bewaakt
// dat de routes met INHOUD van een projectgroep niet (opnieuw) toegang geven
// op grond van "docent van de cursus", en dat de migratie de brede
// docent-leesregels in de database weghaalt. De werking zelf is live getest met
// tijdelijke gebruikers (docent eigen cursus / andere cursus / student).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261008100000_teacher_privacy.sql'), 'utf8');

/** De code van één route (tot de volgende route). */
function routeBlock(signature) {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`route niet gevonden: ${signature}`);
  const next = src.indexOf('\napp.', i + signature.length);
  return src.slice(i, next < 0 ? undefined : next);
}

const GROUP_CONTENT_ROUTES = [
  "app.get('/api/projects/groups/:groupId/conversation-log'",
  "app.get('/api/projects/:projectId/documents/:docId/reviews'",
  "app.get('/api/projects/:projectId/groups/:groupId/relationships'",
  "app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/consultations-grant'",
  "app.get('/api/projects/:projectId/personas/:personaId/documents'",
];

describe('docenten zien de inhoud van projectgroepen niet', () => {
  it.each(GROUP_CONTENT_ROUTES)('%s geeft geen toegang op grond van docentschap', (sig) => {
    const block = routeBlock(sig);
    expect(block).not.toMatch(/isStaffForCourse\(|requireProjectStaff\(/);
    expect(block).toMatch(/isLeapAdmin\(/);
  });

  it('de projectruimte van een groep: alleen leden en beheerders', () => {
    expect(routeBlock("app.get('/api/projects/:projectId/room'"))
      .toContain("if (!isMember && !isLeapAdmin(profile)) return res.status(403)");
  });

  it('feedback op ingeleverd werk: geen docenttoegang', () => {
    const i = src.indexOf('async function loadFeedbackContext');
    const fn = src.slice(i, src.indexOf('\n}\n', i));
    expect(fn).toContain('const isStaff = isLeapAdmin(profile);');
  });

  it('door een groep geüploade bestanden zijn alleen voor die groep', () => {
    const block = routeBlock("app.get('/api/projects/:projectId/personas/:personaId/documents/:docId/download'");
    expect(block).toMatch(/doc\.group_id && doc\.is_hidden_rubric !== true[\s\S]*isGroupMember\(doc\.group_id/);
  });

  it('leerniveaus: alleen de verdeling, geen namen per student', () => {
    const block = routeBlock("app.get('/api/admin/courses/:courseId/learning-levels'");
    expect(block).toContain('levels: [], // per student: bewust niet meer (privacy)');
    expect(block).not.toMatch(/full_name|email: p\?/);
  });

  it('wie zit in welke groep mag wel: alleen namen, geen inhoud', () => {
    const block = routeBlock("app.get('/api/projects/:projectId/groups-overview'");
    expect(block).toContain("select('group_id, user_id, profiles(full_name, email)')");
    expect(block).not.toMatch(/group_chat_messages|group_persona|reviews|relationships/);
  });
});

describe('database: brede docent-leesregels weg, rol niet zelf te wijzigen', () => {
  it.each([
    'Docents can view all journal entries',
    'Docenten and admin can read all attempts',
    'Docenten and admin can read all answers',
    'Docenten and admin can read all explanations',
    'Docenten and admin can read all sessions',
    'Admin and docent can view all profiles',
    'Users can update their own profile',
  ])('regel "%s" wordt verwijderd', (name) => {
    expect(migration).toContain(`DROP POLICY IF EXISTS "${name}"`);
  });
  it('groepsinhoud: alleen groepsleden en beheerders', () => {
    for (const t of ['group_chat_messages', 'group_persona_threads', 'group_checkpoints', 'project_document_reviews', 'project_review_badges', 'project_group_products', 'project_persona_relationships']) {
      expect(migration).toMatch(new RegExp(`ON public\\.${t} FOR SELECT TO authenticated\\s+USING \\(pr_is_group_member\\(group_id\\) OR pr_is_admin\\(\\)\\)`));
    }
  });
  it('rolwijziging alleen door beheerder of server', () => {
    expect(migration).toContain('CREATE TRIGGER pr_guard_profile_role BEFORE INSERT OR UPDATE ON public.profiles');
  });
});
