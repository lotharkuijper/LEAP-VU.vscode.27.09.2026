// Canvas-koppeling via LTI 1.3 (2026-10-23).
//
// Een cursus die de beheerder op "Canvas" zet (courses.enrollment_mode
// 'canvas' of 'canvas_open'), krijgt in Cursussen beheren een Canvas-link:
//   <app>/lti/launch?course=<LEAP-cursus-id>
// De docent zet die in Canvas als externe tool (module-item). Klikt een
// student erop, dan:
//   1. Canvas start de handshake bij  GET|POST /lti/login  (OIDC-start);
//   2. LEAP stuurt de browser terug naar Canvas met een eenmalige state + nonce;
//   3. Canvas stuurt een ONDERTEKEND bericht (id_token) naar  POST /lti/launch:
//      e-mail, naam, rol, Canvas-cursus en de Canvas-link zelf;
//   4. LEAP controleert handtekening, uitgever, bestemming, geldigheid, nonce en
//      deployment; maakt het account (of vindt het), maakt het lid van de cursus
//      (Canvas-docent = docent in LEAP), en logt de student in zonder wachtwoord
//      met een eenmalige inlogcode (generateLink, er gaat geen e-mail uit);
//   5. de browser landt op /lti/start, wisselt de code in en gaat naar de cursus.
// Daarna kan een via Canvas geregistreerde student ook rechtstreeks inloggen
// met een code per e-mail (POST /api/auth/email-code).
//
// Instellingen (geen geheimen in de repo):
//   LTI_PLATFORMS        JSON-lijst [{ issuer, clientId, deploymentIds[], authUrl, jwksUrl }]
//                        of de losse variabelen LTI_ISSUER, LTI_CLIENT_ID,
//                        LTI_DEPLOYMENT_IDS (komma's), LTI_AUTH_URL, LTI_JWKS_URL
//                        óf (sinds 2026-10-29) door de beheerder in Beheer → Instellingen
//                        (chatbot_prompts PLATFORMS_KEY; niet geheim). Beide tellen.
//   LTI_TOOL_PRIVATE_JWK de sleutel van LEAP (JSON, RS256), via Key Vault
//                        (aanmaken: node scripts/lti-keygen.mjs); niet nodig om in te loggen

import { createRemoteJWKSet, jwtVerify, importJWK, exportJWK } from 'jose';
import { randomBytes } from 'node:crypto';
import { canvasGroupRef, placeInCanvasGroup } from '../projects/projectGroups.js';

export const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const CANVAS_MODES = ['canvas', 'canvas_open'];
const TEACHER_ROLES = [
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant',
  'http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant',
];
const STUDENT_ROLES = ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'];

/** Platforms (Canvas-omgevingen) uit de omgeving. Leeg = koppeling uit. */
export function loadPlatforms(env = process.env) {
  if (env.LTI_PLATFORMS) {
    try {
      const list = JSON.parse(env.LTI_PLATFORMS);
      return (Array.isArray(list) ? list : [list]).filter(p => p && p.issuer && p.clientId && p.authUrl && p.jwksUrl)
        .map(p => ({ ...p, deploymentIds: (p.deploymentIds || []).map(String) }));
    } catch {
      console.warn('[lti] LTI_PLATFORMS is geen geldige JSON; koppeling uit');
      return [];
    }
  }
  if (env.LTI_ISSUER && env.LTI_CLIENT_ID && env.LTI_AUTH_URL && env.LTI_JWKS_URL) {
    return [{
      issuer: env.LTI_ISSUER, clientId: env.LTI_CLIENT_ID, authUrl: env.LTI_AUTH_URL, jwksUrl: env.LTI_JWKS_URL,
      deploymentIds: String(env.LTI_DEPLOYMENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    }];
  }
  return [];
}

// Canvas-omgevingen die de beheerder in LEAP zelf instelt (Beheer → Instellingen,
// 2026-10-29). Niets hiervan is geheim (uitgever, Client ID, Deployment ID en
// openbare adressen van Canvas), dus het staat in chatbot_prompts en niet in Key
// Vault. De sleutel van LEAP zelf (LTI_TOOL_PRIVATE_JWK) blijft in Key Vault; die
// is voor inloggen via Canvas niet nodig.
export const PLATFORMS_KEY = '__lti_platforms__';

/** Standaardadressen van de Canvas-cloud van Instructure bij een uitgever. */
export function canvasEndpoints(issuer) {
  const host = (() => { try { return new URL(String(issuer)).host; } catch { return ''; } })();
  const sso = host === 'canvas.test.instructure.com' ? 'sso.test.canvaslms.com'
    : host === 'canvas.beta.instructure.com' ? 'sso.beta.canvaslms.com'
    : host === 'canvas.instructure.com' ? 'sso.canvaslms.com' : null;
  return sso ? { authUrl: `https://${sso}/api/lti/authorize_redirect`, jwksUrl: `https://${sso}/api/lti/security/jwks` } : null;
}

const httpsUrl = (s) => { try { const u = new URL(String(s).trim()); return u.protocol === 'https:' ? u.toString().replace(/\/+$/, '') : null; } catch { return null; } };

/** Eén ingevoerde Canvas-omgeving controleren en aanvullen; null = onbruikbaar. */
export function normalizePlatform(p) {
  if (!p || typeof p !== 'object') return null;
  const issuer = httpsUrl(p.issuer);
  const clientId = String(p.clientId ?? '').trim();
  if (!issuer || !/^[\w.:-]{1,128}$/.test(clientId)) return null;
  const defaults = canvasEndpoints(issuer) || {};
  const authUrl = httpsUrl(p.authUrl || '') || defaults.authUrl;
  const jwksUrl = httpsUrl(p.jwksUrl || '') || defaults.jwksUrl;
  if (!authUrl || !jwksUrl) return null;
  const raw = Array.isArray(p.deploymentIds) ? p.deploymentIds : String(p.deploymentIds ?? '').split(',');
  const deploymentIds = [...new Set(raw.map(d => String(d).trim()).filter(d => /^[\w.:-]{1,200}$/.test(d)))];
  return { issuer, clientId, deploymentIds, authUrl, jwksUrl };
}

/**
 * Alle Canvas-omgevingen: uit de serveromgeving (LTI_PLATFORMS) plus wat de
 * beheerder in LEAP heeft opgeslagen. list() is synchroon (voor de launch);
 * refresh() leest de database opnieuw (bij start en na opslaan).
 */
export function createPlatformRegistry({ envPlatforms = [], getDb }) {
  let saved = [];
  const key = (p) => `${p.issuer}|${p.clientId}`;
  return {
    list() {
      const env = envPlatforms.map(p => ({ ...p, source: 'env' }));
      const seen = new Set(env.map(key));
      return [...env, ...saved.filter(p => !seen.has(key(p))).map(p => ({ ...p, source: 'leap' }))];
    },
    env: () => envPlatforms,
    saved: () => saved,
    async refresh() {
      try {
        const { data } = await getDb().from('chatbot_prompts').select('content').eq('name', PLATFORMS_KEY).maybeSingle();
        const parsed = data?.content ? JSON.parse(data.content) : [];
        saved = (Array.isArray(parsed) ? parsed : []).map(normalizePlatform).filter(Boolean);
      } catch (e) {
        console.warn('[lti] Canvas-omgevingen niet gelezen:', e?.message || e);
      }
      return saved;
    },
    set(list) { saved = list; },
  };
}

/** Recente pogingen van een onbekende Canvas-omgeving (procesgeheugen), zodat de beheerder ze kan overnemen. */
export function createUnknownLog(max = 5) {
  const items = [];
  const clip = (s) => String(s ?? '').slice(0, 200);
  return {
    add({ iss, clientId, deploymentId }, now = new Date()) {
      if (!httpsUrl(iss || '')) return; // rommel niet bewaren
      const entry = { issuer: clip(iss), clientId: clip(clientId), deploymentId: clip(deploymentId), at: now.toISOString() };
      const i = items.findIndex(x => x.issuer === entry.issuer && x.clientId === entry.clientId && x.deploymentId === entry.deploymentId);
      if (i >= 0) items.splice(i, 1);
      items.unshift(entry);
      items.length = Math.min(items.length, max);
    },
    list: () => items.slice(),
  };
}

export function findPlatform(platforms, issuer, clientId) {
  return platforms.find(p => p.issuer === issuer && (!clientId || p.clientId === clientId)) || null;
}

/**
 * LTI-rollen → 'teacher' | 'student' | null. Canvas-docent (en assistent) wordt docent in LEAP.
 * Alleen rollen in DEZE cursus tellen (…/membership#…). Instellingsrollen
 * (…/institution/person#Instructor) krijgt iemand die ergens anders docent of
 * assistent is; die mogen hier nooit docentrechten geven.
 */
export function roleFromLti(roles) {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  if (list.some(r => TEACHER_ROLES.includes(r))) return 'teacher';
  if (list.some(r => STUDENT_ROLES.includes(r))) return 'student';
  return null;
}

/** De LEAP-cursus uit de Canvas-link (target_link_uri ?course=…) of een custom-veld leap_course. */
export function courseIdFromClaims(claims) {
  const custom = claims[`${CLAIM}custom`] || {};
  if (typeof custom.leap_course === 'string' && custom.leap_course) return custom.leap_course;
  try {
    const u = new URL(String(claims[`${CLAIM}target_link_uri`] || ''));
    return u.searchParams.get('course') || null;
  } catch {
    return null;
  }
}

/** Het LEAP-project uit de Canvas-link (?project=…) of een custom-veld leap_project (2026-10-27). */
export function projectIdFromClaims(claims) {
  const custom = claims[`${CLAIM}custom`] || {};
  if (typeof custom.leap_project === 'string' && custom.leap_project) return custom.leap_project;
  try {
    return new URL(String(claims[`${CLAIM}target_link_uri`] || '')).searchParams.get('project') || null;
  } catch {
    return null;
  }
}

/**
 * De Canvas-groep van de student, als het project is geopend vanuit een
 * Canvas-GROEPSOPDRACHT. Canvas vult de custom fields canvas_group_id
 * ($com.instructure.Group.id) en canvas_group_name ($com.instructure.Group.name)
 * alleen daar in; anders staat er de letterlijke naam van de variabele.
 */
export function canvasGroupFromClaims(claims) {
  const custom = claims[`${CLAIM}custom`] || {};
  const id = String(custom.canvas_group_id ?? '').trim();
  if (!id || id.startsWith('$')) return null;
  const rawName = String(custom.canvas_group_name ?? '').trim();
  return { id, name: rawName && !rawName.startsWith('$') ? rawName : null };
}

/** Exact vergelijken (hoofdletterongevoelig): % en _ zijn in een e-mailadres geen jokertekens. */
export const likeExact = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inhoudelijke controle van een al geverifieerd (handtekening/iss/aud/exp) bericht. null = in orde, anders de foutcode. */
export function checkLaunchClaims(claims, platform) {
  if (claims[`${CLAIM}message_type`] !== 'LtiResourceLinkRequest') return 'wrongMessageType';
  if (claims[`${CLAIM}version`] !== '1.3.0') return 'wrongVersion';
  const dep = String(claims[`${CLAIM}deployment_id`] || '');
  if (!dep || (platform.deploymentIds.length && !platform.deploymentIds.includes(dep))) return 'unknownDeployment';
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== platform.clientId) return 'wrongAudience';
  if (!claims.sub) return 'noUser';
  return null;
}

/** Eenmalige state/nonce-opslag (procesgeheugen: één replica). */
export function createStateStore(ttlMs = 10 * 60 * 1000) {
  const map = new Map();
  const sweep = (now) => { for (const [k, v] of map) if (v.exp < now) map.delete(k); };
  return {
    put(state, value, now = Date.now()) { sweep(now); map.set(state, { ...value, exp: now + ttlMs }); },
    take(state, now = Date.now()) {
      const v = map.get(state);
      map.delete(state);
      return v && v.exp >= now ? v : null;
    },
  };
}

/** Developer Key-configuratie voor de Canvas-beheerders (JSON). */
export function canvasToolConfig(appUrl, publicJwk) {
  const base = String(appUrl).replace(/\/+$/, '');
  const domain = (() => { try { return new URL(base).host; } catch { return base; } })();
  return {
    title: 'LEAP',
    description: 'LEAP-VU leeromgeving: studenten openen hun LEAP-cursus vanuit Canvas, zonder wachtwoord.',
    oidc_initiation_url: `${base}/lti/login`,
    target_link_uri: `${base}/lti/launch`,
    ...(publicJwk ? { public_jwk: publicJwk } : { public_jwk_url: `${base}/lti/jwks` }),
    // NRPS: deelnemers (en later de groepsindeling) ophalen. Nog niet gebruikt; vast aangevraagd.
    scopes: ['https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly'],
    extensions: [{
      domain,
      tool_id: 'leap-vu',
      platform: 'canvas.instructure.com',
      privacy_level: 'public',
      settings: {
        text: 'LEAP',
        placements: [
          { placement: 'link_selection', message_type: 'LtiResourceLinkRequest', target_link_uri: `${base}/lti/launch`, windowTarget: '_blank' },
          // Als (groeps)opdracht: alleen dan stuurt Canvas de groep van de student mee.
          { placement: 'assignment_selection', message_type: 'LtiResourceLinkRequest', target_link_uri: `${base}/lti/launch`, windowTarget: '_blank' },
          { placement: 'course_navigation', message_type: 'LtiResourceLinkRequest', target_link_uri: `${base}/lti/launch`, windowTarget: '_blank', default: 'disabled' },
        ],
      },
    }],
    custom_fields: {
      canvas_group_id: '$com.instructure.Group.id',
      canvas_group_name: '$com.instructure.Group.name',
      canvas_course_id: '$Canvas.course.id',
    },
  };
}

/** De Canvas-link voor één LEAP-cursus. */
export function canvasLinkFor(appUrl, courseId, projectId = null) {
  const base = `${String(appUrl).replace(/\/+$/, '')}/lti/launch?course=${encodeURIComponent(courseId)}`;
  return projectId ? `${base}&project=${encodeURIComponent(projectId)}` : base;
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Secure ook op http://localhost: browsers staan dat toe, en zonder Secure weigeren ze
// een cookie met SameSite=None (nodig omdat Canvas via een andere site terugpost).
export function secureCookies(appUrl) {
  try { const u = new URL(appUrl); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return true; }
}

function stateCookie(state, secure) {
  // SameSite=None: Canvas stuurt het bericht via een formulier van een andere site terug.
  // Partitioned (CHIPS): in een Canvas-iframe blokkeren Chrome, Edge en Firefox
  // anders dit cookie van een andere site. Safari blijft een nieuw tabblad nodig hebben.
  return `leap_lti_state=${encodeURIComponent(state)}; Path=/lti; HttpOnly; Max-Age=600; SameSite=None${secure ? '; Secure; Partitioned' : ''}`;
}

/** True als het inlogaccount `userId` precies dit e-mailadres heeft en het bevestigd is. */
export async function verifiedLoginEmail(admin, userId, email) {
  try {
    const { data, error } = await admin.getUserById(userId);
    const u = data?.user;
    if (error || !u) return false;
    return String(u.email || '').trim().toLowerCase() === email && Boolean(u.email_confirmed_at || u.confirmed_at);
  } catch {
    return false;
  }
}

/**
 * Account, lidmaatschap en koppelingen voor een geldige launch.
 * Geeft { userId, email, role, courseId } of { error }.
 */
export async function processLaunch(db, admin, { claims, platform, now = new Date(), promoteTeacher = null }) {
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { error: 'noEmail' };
  const role = roleFromLti(claims[`${CLAIM}roles`]);
  if (!role) return { error: 'noRole' };
  const context = claims[`${CLAIM}context`] || {};

  // Cursus: uit de Canvas-link, anders een eerder vastgelegde koppeling van deze Canvas-cursus.
  let courseId = courseIdFromClaims(claims);
  if (courseId && !UUID.test(courseId)) return { error: 'courseUnknown' };
  if (!courseId && context.id) {
    const { data: links } = await db.from('lti_course_links').select('course_id')
      .eq('issuer', platform.issuer).eq('context_id', String(context.id));
    if ((links || []).length === 1) courseId = links[0].course_id;
  }
  if (!courseId) return { error: 'courseUnknown' };
  const { data: course } = await db.from('courses').select('id, is_active, enrollment_mode').eq('id', courseId).maybeSingle();
  if (!course) return { error: 'courseUnknown' };
  if (!CANVAS_MODES.includes(course.enrollment_mode)) return { error: 'courseNotCanvas' };
  if (course.is_active === false) return { error: 'courseInactive' };

  const stamp = now.toISOString();
  // Account: eerst het vaste Canvas-id, dan het e-mailadres (bestaand account koppelen), anders nieuw.
  let userId = null;
  const { data: ident } = await db.from('lti_identities').select('user_id').eq('issuer', platform.issuer).eq('subject', String(claims.sub)).maybeSingle();
  if (ident) userId = ident.user_id;
  if (!userId) {
    const { data: prof } = await db.from('profiles').select('id').ilike('email', likeExact(email)).limit(1);
    if (prof && prof[0]) {
      // Alleen koppelen aan een account waarvan het INLOG-adres gelijk is en
      // bevestigd: profiles.email kan de eigenaar zelf wijzigen, en een
      // onbevestigde registratie op iemands adres mag diens Canvas-login niet
      // overnemen.
      if (!(await verifiedLoginEmail(admin, prof[0].id, email))) return { error: 'accountConflict' };
      userId = prof[0].id;
    }
  }
  const fullName = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').trim();
  if (!userId) {
    const { data: created, error } = await admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName || email.split('@')[0], source: 'canvas' },
    });
    if (error || !created?.user) return { error: 'accountFailed', detail: error?.message };
    userId = created.user.id;
  }
  await db.from('lti_identities').upsert(
    { user_id: userId, issuer: platform.issuer, subject: String(claims.sub), email, last_launch_at: stamp },
    { onConflict: 'issuer,subject' },
  );

  // Lidmaatschap: Canvas-docent wordt docent; een student wordt nooit "terug" gezet als hij al docent is.
  const { data: member } = await db.from('course_members').select('member_role').eq('course_id', course.id).eq('user_id', userId).maybeSingle();
  if (!member) {
    const { error } = await db.from('course_members').insert({ course_id: course.id, user_id: userId, member_role: role, role });
    if (error) return { error: 'membershipFailed', detail: error.message };
  } else if (role === 'teacher' && member.member_role !== 'teacher') {
    await db.from('course_members').update({ member_role: 'teacher', role: 'teacher' }).eq('course_id', course.id).eq('user_id', userId);
  }
  // Elke weg die iemand cursusdocent maakt, zet ook het profiel op docent
  // (nodig voor de project- en opslagregels in de database).
  if (role === 'teacher' && promoteTeacher) await promoteTeacher(userId, null, course.id);

  if (context.id) {
    await db.from('lti_course_links').upsert(
      { issuer: platform.issuer, context_id: String(context.id), context_title: context.title || context.label || null, course_id: course.id, last_seen: stamp },
      { onConflict: 'issuer,context_id,course_id' },
    );
  }
  await db.from('profiles').update({ last_active_course_id: course.id }).eq('id', userId);

  // Project (2026-10-27): link met ?project=…. Groepsindeling 'canvas' + een student
  // + een Canvas-groep in het bericht → in de LEAP-groep van die Canvas-groep, en
  // meteen naar de projectkamer. Anders naar de projecten van de cursus.
  let next = null;
  const projectId = projectIdFromClaims(claims);
  if (projectId && UUID.test(projectId)) {
    const { data: project } = await db.from('projects').select('id, course_id, group_mode, status').eq('id', projectId).maybeSingle();
    if (project && project.course_id === course.id) {
      next = '/projects';
      const group = canvasGroupFromClaims(claims);
      if (role === 'student' && project.group_mode === 'canvas' && group && project.status !== 'archived') {
        const groupId = await placeInCanvasGroup(db, {
          projectId: project.id, userId, ref: canvasGroupRef(platform.issuer, group.id), name: group.name,
          genInviteCode: () => randomBytes(4).toString('hex').slice(0, 6).toUpperCase(),
        });
        next = `/projects/${project.id}/group/${groupId}`;
      }
    }
  }
  return { userId, email, role, courseId: course.id, next };
}

/**
 * Routes. deps:
 *   supabaseAdmin, platforms, appUrl(req), toolKey ({ privateJwk, publicJwk } | null),
 *   getJwks(platform) (standaard: createRemoteJWKSet), states (createStateStore),
 *   requireAuthUser, isAdminProfile, createAnonClient, rateLimit(key) → boolean
 */
export function registerLtiRoutes(app, express, deps) {
  const db = deps.supabaseAdmin;
  const states = deps.states || createStateStore();
  const registry = deps.registry || null;
  const platforms = () => (registry ? registry.list() : deps.platforms || []);
  const unknown = deps.unknownLog || createUnknownLog();
  const jwksCache = new Map();
  const getJwks = deps.getJwks || ((p) => {
    if (!jwksCache.has(p.jwksUrl)) jwksCache.set(p.jwksUrl, createRemoteJWKSet(new URL(p.jwksUrl)));
    return jwksCache.get(p.jwksUrl);
  });
  const toStart = (req, frag) => `${deps.appUrl(req)}/lti/start#${new URLSearchParams(frag).toString()}`;
  const fail = (req, res, code) => {
    console.warn(`[lti] launch geweigerd: ${code}`);
    return res.redirect(303, toStart(req, { error: code }));
  };

  // 1. OIDC-start: Canvas → LEAP (GET of POST).
  const login = (req, res) => {
    const q = { ...(req.query || {}), ...(req.body || {}) };
    const platform = findPlatform(platforms(), q.iss, q.client_id);
    if (!platform) {
      unknown.add({ iss: q.iss, clientId: q.client_id, deploymentId: q.lti_deployment_id });
      console.warn(`[lti] onbekende Canvas-omgeving: iss=${String(q.iss || '').slice(0, 120)} client_id=${String(q.client_id || '').slice(0, 64)}`);
      return fail(req, res, 'unknownPlatform');
    }
    if (!q.login_hint) return fail(req, res, 'badRequest');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    states.put(state, { nonce, issuer: platform.issuer, clientId: platform.clientId });
    const params = new URLSearchParams({
      scope: 'openid', response_type: 'id_token', response_mode: 'form_post', prompt: 'none',
      client_id: platform.clientId, redirect_uri: `${deps.appUrl(req)}/lti/launch`,
      login_hint: String(q.login_hint), state, nonce,
    });
    if (q.lti_message_hint) params.set('lti_message_hint', String(q.lti_message_hint));
    res.setHeader('Set-Cookie', stateCookie(state, secureCookies(deps.appUrl(req))));
    return res.redirect(302, `${platform.authUrl}?${params.toString()}`);
  };
  app.get('/lti/login', login);
  app.post('/lti/login', express.urlencoded({ extended: false }), login);

  // 2. Launch: Canvas stuurt het ondertekende bericht.
  app.post('/lti/launch', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const { id_token: idToken, state } = req.body || {};
    if (!idToken || !state) return fail(req, res, 'badRequest');
    const saved = states.take(String(state));
    if (!saved) return fail(req, res, 'expired');
    // De state hoort bij deze browser (cookie uit stap 1).
    if (cookieValue(req, 'leap_lti_state') !== String(state)) return fail(req, res, 'stateMismatch');
    const platform = findPlatform(platforms(), saved.issuer, saved.clientId);
    if (!platform) return fail(req, res, 'unknownPlatform');
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(String(idToken), getJwks(platform), {
        issuer: platform.issuer, audience: platform.clientId, maxTokenAge: '10m', clockTolerance: 60,
      }));
    } catch (e) {
      console.warn('[lti] ongeldig bericht:', e?.code || e?.message);
      return fail(req, res, 'invalidToken');
    }
    if (claims.nonce !== saved.nonce) return fail(req, res, 'nonceMismatch');
    const bad = checkLaunchClaims(claims, platform);
    if (bad === 'unknownDeployment') unknown.add({ iss: platform.issuer, clientId: platform.clientId, deploymentId: claims[`${CLAIM}deployment_id`] });
    if (bad) return fail(req, res, bad);
    try {
      const r = await processLaunch(db, db.auth.admin, { claims, platform, promoteTeacher: deps.promoteTeacherProfile || null });
      if (r.error) {
        if (r.detail) console.warn(`[lti] ${r.error}: ${r.detail}`);
        return fail(req, res, r.error);
      }
      const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: r.email });
      const tokenHash = link?.properties?.hashed_token;
      if (error || !tokenHash) {
        console.warn('[lti] inlogcode maken mislukt:', error?.message);
        return fail(req, res, 'loginFailed');
      }
      res.setHeader('Set-Cookie', `leap_lti_state=; Path=/lti; Max-Age=0; SameSite=None${secureCookies(deps.appUrl(req)) ? '; Secure' : ''}`);
      console.log(`[lti] launch ok: ${r.role} → cursus ${r.courseId}`);
      return res.redirect(303, toStart(req, { token_hash: tokenHash, course: r.courseId, ...(r.next ? { next: r.next } : {}) }));
    } catch (e) {
      console.warn('[lti] launch fout:', e?.message || e);
      return fail(req, res, 'loginFailed');
    }
  });

  // 3. Publieke sleutel van LEAP en de configuratie voor de Canvas-beheerders.
  app.get('/lti/jwks', (_req, res) => res.json({ keys: deps.toolKey?.publicJwk ? [deps.toolKey.publicJwk] : [] }));
  app.get('/lti/config.json', (req, res) => res.json(canvasToolConfig(deps.appUrl(req), deps.toolKey?.publicJwk || null)));

  // 4. Voor het beheer: staat de koppeling aan, en wat is de Canvas-link van een cursus?
  app.get('/api/lti/course-link/:courseId', async (req, res) => {
    const auth = await deps.requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await deps.isStaffForCourse(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Onvoldoende rechten' });
    const { data: course } = await db.from('courses').select('id, enrollment_mode').eq('id', courseId).maybeSingle();
    if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });
    const { data: links } = await db.from('lti_course_links').select('context_title, last_seen').eq('course_id', courseId).order('last_seen', { ascending: false }).limit(5);
    // ?project=…: link voor één project (als Canvas-groepsopdracht toevoegen).
    let projectId = null;
    if (req.query.project && UUID.test(String(req.query.project))) {
      const { data: project } = await db.from('projects').select('id').eq('id', String(req.query.project)).eq('course_id', courseId).maybeSingle();
      projectId = project?.id || null;
    }
    return res.json({
      configured: platforms().length > 0,
      canvasMode: CANVAS_MODES.includes(course.enrollment_mode),
      link: canvasLinkFor(deps.appUrl(req), courseId, projectId),
      configUrl: `${deps.appUrl(req)}/lti/config.json`,
      canvasCourses: (links || []).map(l => ({ title: l.context_title, lastSeen: l.last_seen })),
    });
  });

  // 4b. Beheerder: Canvas-omgevingen in LEAP zelf instellen (Beheer → Instellingen).
  app.get('/api/admin/lti-platforms', async (req, res) => {
    if (!deps.requireAdmin || !(await deps.requireAdmin(req, res))) { if (!res.headersSent) res.status(404).end(); return; }
    return res.json({
      env: (registry ? registry.env() : deps.platforms || []).map(({ issuer, clientId, deploymentIds }) => ({ issuer, clientId, deploymentIds })),
      saved: registry ? registry.saved() : [],
      active: platforms().length,
      recentUnknown: unknown.list(),
      toolKey: !!deps.toolKey?.publicJwk,
      configUrl: `${deps.appUrl(req)}/lti/config.json`,
      loginUrl: `${deps.appUrl(req)}/lti/login`,
      launchUrl: `${deps.appUrl(req)}/lti/launch`,
    });
  });
  app.put('/api/admin/lti-platforms', express.json(), async (req, res) => {
    const admin = deps.requireAdmin ? await deps.requireAdmin(req, res) : null;
    if (!admin) { if (!res.headersSent) res.status(404).end(); return; }
    if (!registry) return res.status(503).json({ error: 'Niet beschikbaar' });
    const input = Array.isArray(req.body?.platforms) ? req.body.platforms.slice(0, 10) : null;
    if (!input) return res.status(400).json({ error: 'Ongeldige invoer' });
    const next = input.map(normalizePlatform);
    if (next.some(p => !p)) return res.status(400).json({ error: 'Vul bij elke Canvas-omgeving een geldige uitgever (https) en Client ID in; bij een eigen Canvas-installatie ook de twee adressen.', code: 'ltiPlatformInvalid' });
    const content = JSON.stringify(next);
    const { data: row } = await db.from('chatbot_prompts').select('id, content').eq('name', PLATFORMS_KEY).maybeSingle();
    const { error } = row
      ? await db.from('chatbot_prompts').update({ content }).eq('id', row.id)
      : await db.from('chatbot_prompts').insert({ name: PLATFORMS_KEY, content, is_active: false });
    if (error) return res.status(500).json({ error: error.message });
    try {
      await db.from('leap_setting_changes').insert({
        course_id: null, setting: PLATFORMS_KEY,
        value: { from: row?.content ? JSON.parse(row.content) : null, to: next }, changed_by: admin.id,
      });
    } catch { /* logboek is aanvullend */ }
    registry.set(next);
    console.log(`[lti] Canvas-omgevingen bijgewerkt: ${next.map(p => p.issuer).join(', ') || '(geen)'}`);
    return res.json({ saved: next, active: platforms().length });
  });

  // 5. Inloggen zonder wachtwoord met een code per e-mail, alleen voor accounts die via Canvas zijn aangemaakt.
  app.post('/api/auth/email-code', express.json(), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const ok = () => res.json({ ok: true }); // altijd hetzelfde antwoord: niet verraden of een adres bestaat
    if (!email.includes('@') || email.length > 254) return res.status(400).json({ error: 'Vul een geldig e-mailadres in', code: 'invalidEmail' });
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    if (!deps.rateLimit(`mail:${email}`) || !deps.rateLimit(`ip:${ip}`, 30)) {
      return res.status(429).json({ error: 'Je hebt al een code gevraagd. Wacht even en probeer het opnieuw.', code: 'tooMany' });
    }
    try {
      const { data: prof } = await db.from('profiles').select('id').ilike('email', likeExact(email)).limit(1);
      const uid = prof && prof[0] && prof[0].id;
      if (!uid) return ok();
      const { data: ident } = await db.from('lti_identities').select('id').eq('user_id', uid).limit(1);
      if (!ident || !ident.length) return ok();
      const anon = deps.createAnonClient();
      const { error } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${deps.appUrl(req)}/login` } });
      if (error) console.warn('[email-code] versturen mislukt:', error.message);
      return ok();
    } catch (e) {
      console.warn('[email-code] fout:', e?.message || e);
      return ok();
    }
  });
}

/** Sleutel van LEAP uit LTI_TOOL_PRIVATE_JWK (JSON). null als niet ingesteld of ongeldig. */
export async function loadToolKey(env = process.env) {
  if (!env.LTI_TOOL_PRIVATE_JWK) return null;
  try {
    const jwk = JSON.parse(env.LTI_TOOL_PRIVATE_JWK);
    const key = await importJWK(jwk, 'RS256', { extractable: true });
    const pub = await exportJWK(key);
    const publicJwk = { kty: pub.kty, n: pub.n, e: pub.e, kid: jwk.kid, alg: 'RS256', use: 'sig' };
    return { privateJwk: jwk, publicJwk };
  } catch (e) {
    console.warn('[lti] LTI_TOOL_PRIVATE_JWK ongeldig:', e?.message);
    return null;
  }
}

/** Eenvoudige teller per sleutel per kwartier (procesgeheugen). */
export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 3 } = {}) {
  const hits = new Map();
  return (key, limit = max, now = Date.now()) => {
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
