// Controle van een persona-avatar (cartoon-gezicht) voordat hij wordt opgeslagen.
// De configuratie komt van de client; we slaan alleen een klein, voorspelbaar
// object op: een toegestane stijl, een seed en DiceBear-opties met eenvoudige
// waarden. Alles wat daarbuiten valt, wordt weggelaten. Spiegel van de
// stijllijst in src/lib/personaAvatar.ts.

export const AVATAR_STYLES = ['bottts', 'avataaars', 'lorelei', 'notionists', 'open-peeps'];
const MAX_JSON_CHARS = 4000;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const VALUE_RE = /^[a-zA-Z0-9]{1,40}$/;

/**
 * Pure: geeft een opgeschoonde avatar terug, `null` om de avatar te wissen
 * (terug naar het standaard-robotje), of `undefined` als de invoer ongeldig is.
 */
export function sanitizeAvatar(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const style = typeof input.style === 'string' ? input.style : '';
  if (!AVATAR_STYLES.includes(style)) return undefined;
  const seed = typeof input.seed === 'string' ? input.seed.slice(0, 64) : '';
  const options = {};
  const raw = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_RE.test(k) || k === 'seed') continue;
    if (Number.isInteger(v) && v >= 0 && v <= 100) { options[k] = v; continue; }
    if (Array.isArray(v)) {
      const vals = v.filter((x) => typeof x === 'string' && VALUE_RE.test(x)).slice(0, 5);
      if (vals.length) options[k] = vals;
    }
  }
  const out = { style, seed, options };
  if (JSON.stringify(out).length > MAX_JSON_CHARS) return undefined;
  return out;
}

/** De velden die samen "het gezicht" van een persona vormen, voor zover ze in de patch zitten. */
export function faceFields(patch) {
  const out = {};
  if (patch && 'avatar' in patch) out.avatar = patch.avatar;
  if (patch && 'avatar_emoji' in patch) out.avatar_emoji = patch.avatar_emoji;
  return Object.keys(out).length ? out : null;
}

/** Alleen de gezichtsvelden die echt anders zijn dan `before` (null = niets veranderd). */
export function changedFaceFields(before, patch) {
  const face = faceFields(patch);
  if (!face) return null;
  const out = {};
  for (const [k, v] of Object.entries(face)) {
    if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Eén persona = één gezicht, overal. Past het gezicht aan van het sjabloon
 * (course_personas) en van alle projectkopieën ervan (project_personas met
 * source_persona_id). Alleen het gezicht; naam en instructies mogen per
 * project verschillen.
 *  - Vanuit het sjabloon: `fromTemplate: true` → alleen de kopieën.
 *  - Vanuit een kopie: eerst het sjabloon, maar alleen als dat bij dezelfde
 *    cursus hoort (`courseId`); anders gebeurt er niets buiten het project.
 */
export async function syncPersonaFace(db, { templateId, courseId, fields, fromTemplate = false }) {
  if (!templateId || !fields) return { copies: 0, template: false };
  let template = false;
  if (!fromTemplate) {
    if (!courseId) return { copies: 0, template: false };
    const { data: tpl, error } = await db.from('course_personas').update(fields)
      .eq('id', templateId).eq('course_id', courseId).select('id');
    if (error || !tpl || tpl.length === 0) return { copies: 0, template: false };
    template = true;
  }
  const { data: copies, error } = await db.from('project_personas').update(fields)
    .eq('source_persona_id', templateId).select('id');
  if (error) throw new Error(error.message);
  return { copies: copies?.length || 0, template };
}
