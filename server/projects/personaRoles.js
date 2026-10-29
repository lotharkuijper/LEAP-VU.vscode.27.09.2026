// Rollen van project-bots en de instellingen die daarbij horen (2026-09-29).
// Pure helpers, geen DB: gedeeld door de persona-endpoints (sjablonen én
// project-kopieën) zodat elke route dezelfde velden op dezelfde manier
// opschoont en doorgeeft.
//
//   conversational = Begeleider  — helpt de groep; geen verstandhouding.
//   evaluator      = Beoordelaar — feedback op een product (rubric, rondes).
//   roleplayer     = Rolspeler   — personage in een simulatie; verstandhouding optioneel.

export const PERSONA_TYPES = ['conversational', 'evaluator', 'roleplayer'];
export const MAX_REVIEWS_MAX = 50;
const RULE_MAX_CHARS = 1500;
const LEVEL_RULE_MAX_CHARS = 400;
export const LEVEL_KEYS = ['cold', 'strained', 'neutral', 'positive', 'warm'];

export function normalizePersonaType(value) {
  return PERSONA_TYPES.includes(value) ? value : 'conversational';
}

/** Chat de groep met deze persona? (Beoordelaars niet: die geven alleen feedback op werk.) */
export function isChatPersona(persona) {
  return normalizePersonaType(persona?.persona_type) !== 'evaluator';
}

/** Houdt deze persona een verstandhouding met de groep bij? Alleen een rolspeler, en alleen als de docent dat aanzet. */
export function reputationActive(persona) {
  return normalizePersonaType(persona?.persona_type) === 'roleplayer' && persona?.reputation_enabled === true;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

/** Gedragsregels opschonen: { positive, negative, levels: { cold … warm } }; leeg → null. */
export function sanitizeConductRules(input) {
  if (!input || typeof input !== 'object') return null;
  const levels = {};
  for (const k of LEVEL_KEYS) {
    const t = cleanText(input.levels?.[k], LEVEL_RULE_MAX_CHARS);
    if (t) levels[k] = t;
  }
  const out = {
    positive: cleanText(input.positive, RULE_MAX_CHARS),
    negative: cleanText(input.negative, RULE_MAX_CHARS),
    levels,
  };
  return out.positive || out.negative || Object.keys(levels).length ? out : null;
}

export function clampStartLevel(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-2, Math.min(2, n));
}

export function normalizeMaxReviews(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_REVIEWS_MAX, n);
}

/**
 * Rol-velden uit een verzoek (of uit een sjabloon) opschonen. Alleen velden
 * die in `input` staan komen terug, zodat PATCH niets onbedoeld wist. Velden
 * die niet bij de rol horen worden neutraal gezet (een begeleider houdt nooit
 * een verstandhouding bij, een rolspeler heeft geen feedbackrondes).
 */
export function roleFieldsFrom(input, { partial = false } = {}) {
  const src = input || {};
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(src, k);
  const out = {};
  if (has('persona_type')) out.persona_type = normalizePersonaType(src.persona_type);
  if (has('reputation_enabled')) out.reputation_enabled = src.reputation_enabled === true;
  if (has('conduct_rules')) out.conduct_rules = sanitizeConductRules(src.conduct_rules);
  if (has('start_level')) out.start_level = clampStartLevel(src.start_level);
  if (has('deliverable_label')) out.deliverable_label = cleanText(src.deliverable_label, 120) || null;
  if (has('max_reviews')) out.max_reviews = normalizeMaxReviews(src.max_reviews);
  if (out.persona_type && out.persona_type !== 'roleplayer') out.reputation_enabled = false;
  if (out.persona_type && out.persona_type !== 'evaluator') { out.max_reviews = null; out.deliverable_label = null; }
  return out;
}

/** Velden die van sjabloon naar project-kopie (en terug) meegaan. */
export function copyRoleFields(src) {
  return roleFieldsFrom({
    persona_type: src?.persona_type,
    reputation_enabled: src?.reputation_enabled,
    conduct_rules: src?.conduct_rules,
    start_level: src?.start_level,
    deliverable_label: src?.deliverable_label,
    max_reviews: src?.max_reviews,
  });
}
