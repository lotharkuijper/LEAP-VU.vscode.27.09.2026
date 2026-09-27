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
