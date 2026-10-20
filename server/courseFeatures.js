// Onderdelen per cursus aan/uit (2026-10-15).
//
// courses.features bewaart alleen wat UIT staat ({"quiz": false}); een
// ontbrekende sleutel betekent aan. Uitzetten is verbergen, niet wissen.
// Docenten van de cursus en beheerders blijven een uitgezet onderdeel
// gebruiken (voorbereiden/testen); de app toont het hun met "uit voor
// studenten". Dezelfde regel staat in de database (leap_course_feature_on,
// migratie 20261015100000_course_features) voor wat de browser zelf schrijft.
//
// Pure helpers (geen DB) zodat ze los te testen zijn; de route-koppeling staat
// in server/index.js (loadCourseFeatures / courseFeatureOnFor / rejectIfFeatureOff).

export const COURSE_FEATURES = Object.freeze(['chat', 'explain', 'quiz', 'projects', 'journal', 'studiecafe']);

// Opt-in-onderdelen (2026-10-16): staan alleen aan als de docent ze bewust heeft
// aangezet ({"attachments": true}); een ontbrekende sleutel betekent UIT.
// 'attachments' = bijlagen in de chat (server/chatAttachments.js). In de
// database doet leap_course_feature_on hetzelfde (migratie 20261016100000).
export const OPT_IN_FEATURES = Object.freeze(['attachments']);

// Onderdelen van Ik leg uit (2026-10-20): "Leg zelf uit" en "Verbeter deze uitleg".
// Standaard aan, opgeslagen als false wanneer uit. Ze gelden alleen als 'explain'
// zelf aan staat, en minstens één van beide blijft aan (anders: zet Ik leg uit uit).
export const EXPLAIN_PARTS = Object.freeze(['explainSelf', 'explainImprove']);

export const FEATURE_DISABLED_MSG = 'Dit onderdeel wordt in deze cursus niet gebruikt';

/** Volledige kaart { chat: true, …, attachments: false } uit de opgeslagen waarde (null/rommel = standaard). */
export function normalizeCourseFeatures(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of COURSE_FEATURES) out[key] = src[key] !== false;
  for (const key of EXPLAIN_PARTS) out[key] = src[key] !== false;
  for (const key of OPT_IN_FEATURES) out[key] = src[key] === true;
  return out;
}

export function isFeatureOn(features, feature) {
  if (!COURSE_FEATURES.includes(feature) && !OPT_IN_FEATURES.includes(feature) && !EXPLAIN_PARTS.includes(feature)) return true;
  return normalizeCourseFeatures(features)[feature];
}

/**
 * Valideert een wijziging: { features: { quiz: false, chat: true } }.
 * Alleen bekende sleutels met een echte boolean; minstens één sleutel.
 */
export function parseCourseFeaturesPatch(body) {
  const f = body?.features;
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    return { ok: false, status: 400, body: { error: 'Veld "features" (object) is verplicht' } };
  }
  const keys = Object.keys(f);
  if (keys.length === 0) {
    return { ok: false, status: 400, body: { error: 'Veld "features" (object) is verplicht' } };
  }
  for (const k of keys) {
    if ((!COURSE_FEATURES.includes(k) && !OPT_IN_FEATURES.includes(k) && !EXPLAIN_PARTS.includes(k)) || typeof f[k] !== 'boolean') {
      return { ok: false, status: 400, body: { error: `Onbekend onderdeel of geen ja/nee-waarde: ${k}` } };
    }
  }
  return { ok: true, value: Object.fromEntries(keys.map(k => [k, f[k]])) };
}

/** Wat er opgeslagen wordt: de oude kaart met de wijziging erover; alleen de uitgezette
 *  gewone onderdelen en de aangezette opt-in-onderdelen. */
export function mergeCourseFeatures(stored, patch) {
  const merged = { ...normalizeCourseFeatures(stored), ...patch };
  return Object.fromEntries([
    ...COURSE_FEATURES.filter(k => merged[k] === false).map(k => [k, false]),
    ...EXPLAIN_PARTS.filter(k => merged[k] === false).map(k => [k, false]),
    ...OPT_IN_FEATURES.filter(k => merged[k] === true).map(k => [k, true]),
  ]);
}

/** Een onderdeel van Ik leg uit staat aan als Ik leg uit én dat onderdeel aan staan. */
export function explainPartOn(features, part) {
  const f = normalizeCourseFeatures(features);
  return f.explain && f[part];
}

/** Minstens één onderdeel van Ik leg uit moet aan blijven. */
export function explainPartsValid(features) {
  const f = normalizeCourseFeatures(features);
  return EXPLAIN_PARTS.some(k => f[k]);
}

const QUIZ_PROMPT_MODES = new Set([
  'quiz_generate_strict', 'quiz_generate_blended', 'quiz_generate_creative', 'quiz_verify', 'quiz_evaluate_open',
]);

/**
 * Bij welk onderdeel hoort een /api/chat-aanroep? Dat ene adres bedient ook
 * Ik leg uit, de quiz en de begrippenextractie (beheer); alleen wat zich als
 * onderdeel herkenbaar maakt telt, de rest (null) wordt niet tegengehouden.
 */
export function featureForChatRequest(body) {
  const b = body || {};
  if (b.promptMode === 'explain') return 'explain';
  if (QUIZ_PROMPT_MODES.has(b.promptMode)) return 'quiz';
  if (b.purpose === 'tutor_chat' || b.readinessCheck === true) return 'chat';
  return null;
}

/** Mag deze gebruiker het onderdeel gebruiken? Staf van de cursus altijd. */
export function featureAllowed({ features, feature, isStaff }) {
  if (isStaff) return true;
  return isFeatureOn(features, feature);
}
