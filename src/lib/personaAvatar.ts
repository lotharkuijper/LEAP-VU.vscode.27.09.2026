// Cartoon-gezichten voor persona's (DiceBear). De configuratie die we opslaan
// is klein: { style, seed, options }. Zonder configuratie krijgt een persona
// een robotje dat uit de naam wordt afgeleid, zodat iedereen een gezicht heeft.
// Stijlmodules worden pas geladen als ze nodig zijn (lazy) en onthouden.
// De stijllijst staat ook in server/personaAvatar.js (serverzijdige controle).

import type { TranslationKey } from '../i18n/translations';

export type AvatarStyle = 'bottts' | 'avataaars' | 'lorelei' | 'notionists' | 'open-peeps';

export interface AvatarConfig {
  style: AvatarStyle;
  seed: string;
  options: Record<string, string[] | number>;
}

export interface AvatarPart {
  /** DiceBear-optienaam (eyes, top, hairColor, …). */
  key: string;
  kind: 'shape' | 'color';
  /** i18n-sleutel van het label. */
  labelKey: TranslationKey;
}

const shape = (key: string, labelKey = `persona.avatar.part.${key}`): AvatarPart => ({ key, kind: 'shape', labelKey: labelKey as TranslationKey });
const color = (key: string, labelKey = `persona.avatar.part.${key}`): AvatarPart => ({ key, kind: 'color', labelKey: labelKey as TranslationKey });

export const AVATAR_STYLES: Array<{ id: AvatarStyle; labelKey: TranslationKey; parts: AvatarPart[] }> = [
  {
    id: 'bottts', labelKey: 'persona.avatar.style.bottts',
    parts: [color('baseColor'), shape('top', 'persona.avatar.part.antenna'), shape('eyes'), shape('mouth'),
      shape('face', 'persona.avatar.part.headShape'), shape('sides', 'persona.avatar.part.ears'), shape('texture')],
  },
  {
    id: 'avataaars', labelKey: 'persona.avatar.style.avataaars',
    parts: [color('skinColor'), shape('top', 'persona.avatar.part.hairOrHat'), color('hairColor'), shape('eyes'),
      shape('eyebrows'), shape('mouth'), shape('facialHair'), color('facialHairColor'), shape('accessories'),
      shape('clothing'), color('clothesColor'), shape('clothingGraphic')],
  },
  {
    id: 'lorelei', labelKey: 'persona.avatar.style.lorelei',
    parts: [shape('hair'), shape('eyes'), shape('eyebrows'), shape('mouth'), shape('nose'),
      shape('head', 'persona.avatar.part.headShape'), shape('glasses'), shape('beard'), shape('earrings')],
  },
  {
    id: 'notionists', labelKey: 'persona.avatar.style.notionists',
    parts: [shape('hair'), shape('eyes'), shape('brows', 'persona.avatar.part.eyebrows'), shape('lips', 'persona.avatar.part.mouth'),
      shape('nose'), shape('beard'), shape('glasses'), shape('body', 'persona.avatar.part.clothing'), shape('gesture')],
  },
  {
    id: 'open-peeps', labelKey: 'persona.avatar.style.openPeeps',
    parts: [color('skinColor'), shape('head', 'persona.avatar.part.hair'), shape('face', 'persona.avatar.part.expression'),
      shape('facialHair'), shape('accessories'), shape('mask'), color('clothingColor')],
  },
];

/** Zachte achtergrondkleuren (hex zonder #); 'transparent' = geen. */
export const AVATAR_BACKGROUNDS = ['transparent', 'b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'fde68a', 'bbf7d0', 'e5e7eb'];

/** Het standaard-robotje: afgeleid van de naam, met een zachte achtergrond. */
export function defaultAvatar(name: string): AvatarConfig {
  return {
    style: 'bottts',
    seed: name || 'persona',
    options: { backgroundColor: ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf'] },
  };
}

/** Geldige opgeslagen avatar of het standaard-robotje. */
export function resolveAvatar(avatar: unknown, name: string): AvatarConfig {
  const a = avatar as AvatarConfig | null | undefined;
  if (a && typeof a === 'object' && AVATAR_STYLES.some(s => s.id === a.style)) {
    return { style: a.style, seed: typeof a.seed === 'string' ? a.seed : name, options: a.options && typeof a.options === 'object' ? a.options : {} };
  }
  return defaultAvatar(name);
}

// ---- Stijlmodules (lazy) -------------------------------------------------

type StyleModule = { schema: any; create: any; meta?: any };
const LOADERS: Record<AvatarStyle, () => Promise<StyleModule>> = {
  bottts: () => import('@dicebear/bottts') as Promise<StyleModule>,
  avataaars: () => import('@dicebear/avataaars') as Promise<StyleModule>,
  lorelei: () => import('@dicebear/lorelei') as Promise<StyleModule>,
  notionists: () => import('@dicebear/notionists') as Promise<StyleModule>,
  'open-peeps': () => import('@dicebear/open-peeps') as Promise<StyleModule>,
};
let corePromise: Promise<typeof import('@dicebear/core')> | null = null;
let core: typeof import('@dicebear/core') | null = null;
const loaded = new Map<AvatarStyle, StyleModule>();
const pending = new Map<AvatarStyle, Promise<StyleModule>>();

export function loadStyle(style: AvatarStyle): Promise<StyleModule> {
  const have = loaded.get(style);
  if (have && core) return Promise.resolve(have);
  let p = pending.get(style);
  if (!p) {
    corePromise ||= import('@dicebear/core').then(m => (core = m));
    p = Promise.all([LOADERS[style](), corePromise]).then(([m]) => { loaded.set(style, m); return m; });
    pending.set(style, p);
  }
  return p;
}

/** Keuzes voor een onderdeel uit het stijlschema (vormen of kleurenpalet). */
export function partChoices(style: AvatarStyle, part: AvatarPart): string[] {
  const m = loaded.get(style);
  const prop = m?.schema?.properties?.[part.key];
  if (!prop) return [];
  if (part.kind === 'shape') return Array.isArray(prop.items?.enum) ? prop.items.enum : [];
  return Array.isArray(prop.default) ? prop.default : [];
}

/** Heeft dit onderdeel een "geen"-keuze (via de bijbehorende *Probability)? */
export function partCanBeEmpty(style: AvatarStyle, part: AvatarPart): boolean {
  return !!loaded.get(style)?.schema?.properties?.[`${part.key}Probability`];
}

const uriCache = new Map<string, string>();

/** Data-URI van de avatar, of null zolang de stijl nog niet geladen is. */
export function avatarDataUriSync(cfg: AvatarConfig): string | null {
  const m = loaded.get(cfg.style);
  if (!m || !core) return null;
  const key = JSON.stringify(cfg);
  const hit = uriCache.get(key);
  if (hit) return hit;
  let uri: string;
  try {
    uri = core.createAvatar(m as any, { seed: cfg.seed, ...(cfg.options as any) }).toDataUri();
  } catch {
    uri = core.createAvatar(m as any, { seed: cfg.seed }).toDataUri();
  }
  if (uriCache.size > 500) uriCache.clear();
  uriCache.set(key, uri);
  return uri;
}

/** Een willekeurige seed voor "Verras me" en de variantengalerij. */
export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
