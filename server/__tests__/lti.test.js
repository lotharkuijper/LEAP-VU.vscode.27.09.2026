// Canvas-koppeling via LTI 1.3 (server/lti/lti.js, 2026-10-23). Een nep-Canvas met
// een eigen sleutelpaar ondertekent echte berichten; de routes draaien in een
// echte Express-app met een kleine nep-database.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import {
  CLAIM, loadPlatforms, roleFromLti, courseIdFromClaims, checkLaunchClaims, createStateStore,
  canvasToolConfig, canvasLinkFor, likeExact, registerLtiRoutes, createRateLimiter, secureCookies,
  projectIdFromClaims, canvasGroupFromClaims, normalizePlatform, canvasEndpoints, createPlatformRegistry, PLATFORMS_KEY,
} from '../lti.js';

const ISS = 'https://canvas.test';
const CLIENT = 'client-1';
const DEP = 'dep-1';
const COURSE = '11111111-1111-4111-8111-111111111111';
const platform = { issuer: ISS, clientId: CLIENT, deploymentIds: [DEP], authUrl: 'https://canvas.test/auth', jwksUrl: 'https://canvas.test/jwks' };
let keys, otherKeys, jwks;
let promoted = [];

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  otherKeys = await generateKeyPair('RS256');
  const pub = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: 'k1', alg: 'RS256' }] });
});

const claimsFor = (over = {}) => ({
  nonce: 'n', sub: 'canvas-user-1', email: 'Student@Example.org', name: 'Sam Student',
  [`${CLAIM}message_type`]: 'LtiResourceLinkRequest', [`${CLAIM}version`]: '1.3.0',
  [`${CLAIM}deployment_id`]: DEP,
  [`${CLAIM}roles`]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
  [`${CLAIM}context`]: { id: 'ctx-9', title: 'Statistiek 1' },
  [`${CLAIM}target_link_uri`]: `http://localhost/lti/launch?course=${COURSE}`,
  ...over,
});
const sign = (claims, key = keys.privateKey, opts = {}) => new SignJWT(claims)
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.iss || ISS).setAudience(opts.aud || CLIENT)
  .setIssuedAt().setExpirationTime(opts.exp || '5m').sign(key);

describe('regels', () => {
  it('rollen: Canvas-docent (en assistent) wordt docent, Learner wordt student, rest niets', () => {
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'])).toBe('teacher');
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant'])).toBe('teacher');
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'])).toBe('student');
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student'])).toBe(null);
    // Docent of assistent ELDERS (instellingsrol) geeft hier geen docentrechten.
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor', 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'])).toBe('student');
    expect(roleFromLti(['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor'])).toBe(null);
    expect(roleFromLti(undefined)).toBe(null);
  });
  it('de cursus komt uit de Canvas-link of een custom-veld', () => {
    expect(courseIdFromClaims(claimsFor())).toBe(COURSE);
    expect(courseIdFromClaims({ [`${CLAIM}custom`]: { leap_course: 'x' } })).toBe('x');
    expect(courseIdFromClaims({})).toBe(null);
    expect(canvasLinkFor('https://leap.test/', COURSE)).toBe(`https://leap.test/lti/launch?course=${COURSE}`);
  });
  it('inhoudelijke controle: soort bericht, versie, deployment', () => {
    expect(checkLaunchClaims(claimsFor(), platform)).toBe(null);
    expect(checkLaunchClaims(claimsFor({ [`${CLAIM}message_type`]: 'LtiDeepLinkingRequest' }), platform)).toBe('wrongMessageType');
    expect(checkLaunchClaims(claimsFor({ [`${CLAIM}deployment_id`]: 'ander' }), platform)).toBe('unknownDeployment');
  });
  it('state is eenmalig en verloopt', () => {
    const st = createStateStore(1000);
    st.put('s', { nonce: 'n' }, 0);
    expect(st.take('s', 500)?.nonce).toBe('n');
    expect(st.take('s', 600)).toBe(null);
    st.put('t', { nonce: 'n' }, 0);
    expect(st.take('t', 5000)).toBe(null);
  });
  it('platforms uit de omgeving; e-mail exact zoeken (_ en % geen jokertekens)', () => {
    expect(loadPlatforms({ LTI_ISSUER: ISS, LTI_CLIENT_ID: CLIENT, LTI_AUTH_URL: 'a', LTI_JWKS_URL: 'j', LTI_DEPLOYMENT_IDS: 'd1, d2' })[0].deploymentIds).toEqual(['d1', 'd2']);
    expect(loadPlatforms({})).toEqual([]);
    expect(likeExact('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
  it('configuratie voor Canvas: nieuw tabblad, minimale gegevens', () => {
    const cfg = canvasToolConfig('https://leap.test');
    expect(cfg.oidc_initiation_url).toBe('https://leap.test/lti/login');
    expect(cfg.extensions[0].settings.placements.every(p => p.windowTarget === '_blank')).toBe(true);
    // Minimaal: alleen leesrecht op deelnemers (NRPS), voor de groepsindeling uit Canvas.
    expect(cfg.scopes).toEqual(['https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly']);
  });
  it('groepen uit Canvas (2026-10-27): custom fields, plaatsing als opdracht, link per project', () => {
    const cfg = canvasToolConfig('https://leap.test');
    expect(cfg.custom_fields).toEqual({
      canvas_group_id: '$com.instructure.Group.id',
      canvas_group_name: '$com.instructure.Group.name',
      canvas_course_id: '$Canvas.course.id',
    });
    expect(cfg.extensions[0].settings.placements.map(p => p.placement)).toContain('assignment_selection');
    const P = '11111111-1111-4111-8111-111111111111';
    expect(canvasLinkFor('https://leap.test/', 'c1', P)).toBe(`https://leap.test/lti/launch?course=c1&project=${P}`);
    expect(projectIdFromClaims({ [`${CLAIM}target_link_uri`]: `https://leap.test/lti/launch?course=c1&project=${P}` })).toBe(P);
    expect(canvasGroupFromClaims({ [`${CLAIM}custom`]: { canvas_group_id: '481', canvas_group_name: 'Groep 3' } })).toEqual({ id: '481', name: 'Groep 3' });
    // Niet vanuit een groepsopdracht: Canvas laat de variabele staan.
    expect(canvasGroupFromClaims({ [`${CLAIM}custom`]: { canvas_group_id: '$com.instructure.Group.id' } })).toBeNull();
    expect(canvasGroupFromClaims({})).toBeNull();
  });
  it('state-cookie is Secure op https én localhost (anders weigert de browser SameSite=None)', () => {
    expect(secureCookies('https://leap.test')).toBe(true);
    expect(secureCookies('http://localhost:5000')).toBe(true);
    expect(secureCookies('http://intern.test')).toBe(false);
  });
  it('limiet op codes per e-mail', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl('a', 2, 0)).toBe(true); expect(rl('a', 2, 1)).toBe(true); expect(rl('a', 2, 2)).toBe(false);
    expect(rl('a', 2, 2000)).toBe(true);
  });
});

// ── Routes met nep-database ──────────────────────────────────────────────────
let server, state, otpCalls;
function fakeDb() {
  const tables = state.db;
  const match = (r, f) => Object.entries(f.eq).every(([k, v]) => String(r[k]) === String(v))
    && (!f.ilike || String(r[f.ilike[0]]).toLowerCase() === String(f.ilike[1]).replace(/\\(.)/g, '$1').toLowerCase());
  const from = (t) => {
    const f = { eq: {}, ilike: null };
    const rows = () => (tables[t] ||= []).filter(r => match(r, f));
    const b = {
      select: () => b, order: () => b, limit: () => b,
      eq: (k, v) => { f.eq[k] = v; return b; },
      ilike: (k, v) => { f.ilike = [k, v]; return b; },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      then: (res) => res({ data: rows(), error: null }),
      insert: async (row) => { (tables[t] ||= []).push({ ...row }); return { error: null }; },
      upsert: async (row, { onConflict }) => {
        const keysC = onConflict.split(',');
        const list = (tables[t] ||= []);
        const ex = list.find(r => keysC.every(k => r[k] === row[k]));
        if (ex) Object.assign(ex, row); else list.push({ ...row });
        return { error: null };
      },
      update: (vals) => { const u = { eq: (k, v) => { f.eq[k] = v; return u; }, then: (res) => { rows().forEach(r => Object.assign(r, vals)); res({ error: null }); } }; return u; },
    };
    return b;
  };
  return {
    from,
    auth: { admin: {
      createUser: async ({ email }) => { const id = `u-${(tables.profiles || []).length + 1}`; (tables.profiles ||= []).push({ id, email }); state.auth[id] = { id, email, email_confirmed_at: 'now' }; return { data: { user: { id } }, error: null }; },
      getUserById: async (id) => ({ data: state.auth[id] ? { user: state.auth[id] } : null, error: state.auth[id] ? null : { message: 'not found' } }),
      generateLink: async ({ email }) => ({ data: { properties: { hashed_token: `hash-for-${email}` } }, error: null }),
    } },
  };
}

async function req(method, path, { body, cookie, form } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: {
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    } }, (res) => { let raw = ''; res.on('data', c => (raw += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

/** Volledige handshake zoals Canvas hem doet; geeft de doorverwijzing van /lti/launch. */
async function launch(over = {}, { keyOver, cookieOver, aud } = {}) {
  const init = await req('GET', `/lti/login?iss=${encodeURIComponent(ISS)}&client_id=${CLIENT}&login_hint=x&target_link_uri=x`);
  const loc = new URL(init.headers.location);
  const st = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');
  const cookie = cookieOver ?? String(init.headers['set-cookie']?.[0] || '').split(';')[0];
  const token = await sign(claimsFor({ nonce, ...over }), keyOver || keys.privateKey, { aud });
  const res = await req('POST', '/lti/launch', { form: { id_token: token, state: st }, cookie });
  return { res, frag: new URLSearchParams(new URL(res.headers.location).hash.slice(1)) };
}

beforeEach(async () => {
  otpCalls = [];
  state = { db: {
    courses: [{ id: COURSE, is_active: true, enrollment_mode: 'canvas' }],
    profiles: [], lti_identities: [], course_members: [], lti_course_links: [],
  }, auth: {} };
  promoted = [];
  const app = express();
  app.use(express.json());
  registerLtiRoutes(app, express, {
    supabaseAdmin: fakeDb(),
    platforms: [platform],
    appUrl: () => 'http://leap.local',
    toolKey: null,
    getJwks: () => jwks,
    requireAuthUser: async () => ({ user: { id: 'admin' }, profile: { role: 'admin' } }),
    isStaffForCourse: async () => true,
    promoteTeacherProfile: async (userId, changedBy, courseId) => { promoted.push({ userId, courseId }); },
    createAnonClient: () => ({ auth: { signInWithOtp: async (a) => { otpCalls.push(a); return { error: null }; } } }),
    rateLimit: createRateLimiter({ max: 3 }),
  });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
});
afterEach(async () => { await new Promise(r => server.close(r)); });

describe('launch vanuit Canvas', () => {
  it('nieuwe student: account, lidmaatschap, koppeling en eenmalige inlogcode', async () => {
    const { res, frag } = await launch();
    expect(res.status).toBe(303);
    expect(res.headers.location.startsWith('http://leap.local/lti/start#')).toBe(true);
    expect(frag.get('token_hash')).toBe('hash-for-student@example.org');
    expect(frag.get('course')).toBe(COURSE);
    expect(state.db.course_members).toEqual([{ course_id: COURSE, user_id: 'u-1', member_role: 'student', role: 'student' }]);
    expect(promoted).toEqual([]);
    expect(state.db.lti_identities[0]).toMatchObject({ user_id: 'u-1', issuer: ISS, subject: 'canvas-user-1', email: 'student@example.org' });
    expect(state.db.lti_course_links[0]).toMatchObject({ context_id: 'ctx-9', context_title: 'Statistiek 1', course_id: COURSE });
    expect(state.db.profiles[0].last_active_course_id).toBe(COURSE);
  });
  it('tweede keer: hetzelfde account, geen dubbel lidmaatschap', async () => {
    await launch();
    await launch();
    expect(state.db.profiles).toHaveLength(1);
    expect(state.db.course_members).toHaveLength(1);
  });
  it('Canvas-docent wordt docent; een bestaand account met hetzelfde e-mailadres wordt gekoppeld', async () => {
    state.db.profiles.push({ id: 'bestaand', email: 'docent@example.org' });
    state.auth.bestaand = { id: 'bestaand', email: 'docent@example.org', email_confirmed_at: '2026-01-01' };
    state.db.course_members.push({ course_id: COURSE, user_id: 'bestaand', member_role: 'student' });
    await launch({ sub: 'canvas-docent', email: 'Docent@example.org', [`${CLAIM}roles`]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] });
    expect(state.db.profiles).toHaveLength(1);
    expect(state.db.course_members[0].member_role).toBe('teacher');
    // Cursusdocent ⇒ ook het profiel docent (project-/opslagregels in de database).
    expect(promoted).toEqual([{ userId: 'bestaand', courseId: COURSE }]);
  });
  it('koppelt niet aan een account met een onbevestigd of ander inlogadres (overname voorkomen)', async () => {
    // a) iemand registreerde zich op dit adres maar bevestigde het nooit
    state.db.profiles.push({ id: 'onbevestigd', email: 'student@example.org' });
    state.auth.onbevestigd = { id: 'onbevestigd', email: 'student@example.org', email_confirmed_at: null };
    let { frag } = await launch();
    expect(frag.get('error')).toBe('accountConflict');
    expect(state.db.lti_identities).toHaveLength(0);
    expect(state.db.course_members).toHaveLength(0);
    // b) iemand zette dit adres alleen in zijn profiel; zijn inlogadres is anders
    state.db.profiles = [{ id: 'kaper', email: 'student@example.org' }];
    state.auth = { kaper: { id: 'kaper', email: 'kaper@example.org', email_confirmed_at: '2026-01-01' } };
    ({ frag } = await launch());
    expect(frag.get('error')).toBe('accountConflict');
    expect(state.db.lti_identities).toHaveLength(0);
  });
  it('een docent wordt nooit teruggezet naar student', async () => {
    state.db.profiles.push({ id: 'd', email: 'student@example.org' });
    state.db.course_members.push({ course_id: COURSE, user_id: 'd', member_role: 'teacher' });
    await launch();
    expect(state.db.course_members[0].member_role).toBe('teacher');
  });
  it('vervalst of verkeerd bericht wordt geweigerd', async () => {
    expect((await launch({}, { keyOver: otherKeys.privateKey })).frag.get('error')).toBe('invalidToken');
    expect((await launch({}, { aud: 'iemand-anders' })).frag.get('error')).toBe('invalidToken');
    expect((await launch({ nonce: 'verkeerd' })).frag.get('error')).toBe('nonceMismatch');
    expect((await launch({ [`${CLAIM}deployment_id`]: 'x' })).frag.get('error')).toBe('unknownDeployment');
    expect(state.db.course_members).toHaveLength(0);
  });
  it('state hoort bij de browser en is eenmalig', async () => {
    expect((await launch({}, { cookieOver: 'leap_lti_state=iets-anders' })).frag.get('error')).toBe('stateMismatch');
    const init = await req('GET', `/lti/login?iss=${encodeURIComponent(ISS)}&client_id=${CLIENT}&login_hint=x`);
    const loc = new URL(init.headers.location);
    const cookie = String(init.headers['set-cookie'][0]).split(';')[0];
    const token = await sign(claimsFor({ nonce: loc.searchParams.get('nonce') }));
    await req('POST', '/lti/launch', { form: { id_token: token, state: loc.searchParams.get('state') }, cookie });
    const again = await req('POST', '/lti/launch', { form: { id_token: token, state: loc.searchParams.get('state') }, cookie });
    expect(new URLSearchParams(new URL(again.headers.location).hash.slice(1)).get('error')).toBe('expired');
  });
  it('cursus niet op Canvas, geen e-mail of geen rol: nette foutmelding', async () => {
    state.db.courses[0].enrollment_mode = 'open';
    expect((await launch()).frag.get('error')).toBe('courseNotCanvas');
    state.db.courses[0].enrollment_mode = 'canvas_open';
    expect((await launch({ email: undefined })).frag.get('error')).toBe('noEmail');
    expect((await launch({ [`${CLAIM}roles`]: [] })).frag.get('error')).toBe('noRole');
    expect((await launch({ [`${CLAIM}target_link_uri`]: 'http://x/lti/launch?course=geen-uuid' })).frag.get('error')).toBe('courseUnknown');
  });
  it('Canvas-cursus van een vorige editie: oud-deelnemer, geen (nieuw) lid of docent', async () => {
    state.db.course_alumni = [];
    state.db.lti_course_links.push({ issuer: ISS, context_id: 'ctx-9', course_id: COURSE, retired_at: '2026-10-29T10:00:00Z' });
    const { frag } = await launch({ [`${CLAIM}roles`]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] });
    expect(frag.get('token_hash')).toBeTruthy(); // inloggen en lezen kan nog
    expect(state.db.course_members).toHaveLength(0);
    expect(state.db.course_alumni[0]).toMatchObject({ course_id: COURSE, user_id: 'u-1', former_role: 'teacher' });
  });
  it('onbekende Canvas-omgeving wordt niet doorgestuurd', async () => {
    const r = await req('GET', '/lti/login?iss=https%3A%2F%2Fevil.test&client_id=x&login_hint=x');
    expect(new URLSearchParams(new URL(r.headers.location).hash.slice(1)).get('error')).toBe('unknownPlatform');
  });
});

describe('Canvas-omgevingen instellen in LEAP (2026-10-29)', () => {
  it('controleert invoer en vult de adressen van de Canvas-cloud aan', () => {
    expect(normalizePlatform({ issuer: 'https://canvas.instructure.com/', clientId: ' 104020000000000409 ', deploymentIds: '732:f952a58c, 732:f952a58c' })).toEqual({
      issuer: 'https://canvas.instructure.com', clientId: '104020000000000409', deploymentIds: ['732:f952a58c'],
      authUrl: 'https://sso.canvaslms.com/api/lti/authorize_redirect', jwksUrl: 'https://sso.canvaslms.com/api/lti/security/jwks',
    });
    expect(canvasEndpoints('https://canvas.test.instructure.com').authUrl).toBe('https://sso.test.canvaslms.com/api/lti/authorize_redirect');
    expect(normalizePlatform({ issuer: 'http://canvas.instructure.com', clientId: '1' })).toBeNull();
    expect(normalizePlatform({ issuer: 'https://eigen.canvas.nl', clientId: '1' })).toBeNull(); // eigen installatie: adressen verplicht
    expect(normalizePlatform({ issuer: 'https://eigen.canvas.nl', clientId: '1', authUrl: 'https://eigen.canvas.nl/a', jwksUrl: 'https://eigen.canvas.nl/j' })).toMatchObject({ deploymentIds: [] });
  });

  it('beheerder slaat een omgeving op; daarna lukt de launch zonder herstart, en een onbekende poging is over te nemen', async () => {
    await new Promise(r => server.close(r));
    state.db.chatbot_prompts = [];
    state.db.leap_setting_changes = [];
    const registry = createPlatformRegistry({ envPlatforms: [], getDb: () => db });
    const db = fakeDb();
    let isAdmin = true;
    const app = express();
    app.use(express.json());
    registerLtiRoutes(app, express, {
      supabaseAdmin: db, registry, appUrl: () => 'http://leap.local', toolKey: null, getJwks: () => jwks,
      requireAuthUser: async () => ({ user: { id: 'admin' }, profile: { role: 'admin' } }),
      requireAdmin: async (_q, res) => (isAdmin ? { id: 'admin' } : (res.status(403).json({ error: 'nee' }), null)),
      isStaffForCourse: async () => true, createAnonClient: () => ({}), rateLimit: createRateLimiter({ max: 3 }),
    });
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    // Nog niets ingesteld: Canvas klopt aan en wordt geweigerd, maar LEAP onthoudt wie het was.
    const first = await req('GET', `/lti/login?iss=${encodeURIComponent(ISS)}&client_id=${CLIENT}&lti_deployment_id=${DEP}&login_hint=x`);
    expect(new URLSearchParams(new URL(first.headers.location).hash.slice(1)).get('error')).toBe('unknownPlatform');
    await req('GET', '/lti/login?iss=rommel&client_id=x&login_hint=x');
    const before = JSON.parse((await req('GET', '/api/admin/lti-platforms')).body);
    expect(before.active).toBe(0);
    expect(before.recentUnknown).toEqual([expect.objectContaining({ issuer: ISS, clientId: CLIENT, deploymentId: DEP })]);

    const bad = await req('PUT', '/api/admin/lti-platforms', { body: { platforms: [{ issuer: 'geen-url', clientId: 'x' }] } });
    expect(bad.status).toBe(400);
    const put = await req('PUT', '/api/admin/lti-platforms', { body: { platforms: [{ issuer: ISS, clientId: CLIENT, deploymentIds: DEP, authUrl: platform.authUrl, jwksUrl: platform.jwksUrl }] } });
    expect(put.status).toBe(200);
    expect(JSON.parse(state.db.chatbot_prompts[0].content)[0]).toMatchObject({ issuer: ISS, clientId: CLIENT, deploymentIds: [DEP] });
    expect(state.db.leap_setting_changes[0]).toMatchObject({ setting: PLATFORMS_KEY, changed_by: 'admin' });

    const { frag } = await launch();
    expect(frag.get('token_hash')).toBe('hash-for-student@example.org');

    // Na een herstart leest LEAP de opgeslagen omgeving weer in.
    const fresh = createPlatformRegistry({ envPlatforms: [], getDb: () => db });
    await fresh.refresh();
    expect(fresh.list()).toEqual([expect.objectContaining({ issuer: ISS, source: 'leap' })]);

    isAdmin = false;
    expect((await req('GET', '/api/admin/lti-platforms')).status).toBe(403);
    expect((await req('PUT', '/api/admin/lti-platforms', { body: { platforms: [] } })).status).toBe(403);
  });

  it('omgeving uit de serveromgeving gaat voor; een ingestelde omgeving telt erbij', () => {
    const reg = createPlatformRegistry({ envPlatforms: [platform], getDb: () => null });
    reg.set([{ ...platform, deploymentIds: [] }, { ...platform, clientId: 'tweede' }]);
    expect(reg.list().map(p => `${p.clientId}:${p.source}`)).toEqual(['client-1:env', 'tweede:leap']);
  });
});

describe('inloggen met een code per e-mail', () => {
  it('alleen voor accounts die via Canvas binnenkwamen; antwoord verraadt niets', async () => {
    await launch();
    let r = await req('POST', '/api/auth/email-code', { body: { email: 'student@example.org' } });
    expect(r.status).toBe(200);
    expect(otpCalls).toHaveLength(1);
    expect(otpCalls[0].options.shouldCreateUser).toBe(false);
    state.db.profiles.push({ id: 'p2', email: 'gewoon@example.org' });
    r = await req('POST', '/api/auth/email-code', { body: { email: 'gewoon@example.org' } });
    expect(r.status).toBe(200);
    r = await req('POST', '/api/auth/email-code', { body: { email: 'onbekend@example.org' } });
    expect(r.status).toBe(200);
    expect(otpCalls).toHaveLength(1);
  });
  it('niet eindeloos codes aanvragen', async () => {
    for (let i = 0; i < 3; i++) await req('POST', '/api/auth/email-code', { body: { email: 'x@example.org' } });
    expect((await req('POST', '/api/auth/email-code', { body: { email: 'x@example.org' } })).status).toBe(429);
  });
});
