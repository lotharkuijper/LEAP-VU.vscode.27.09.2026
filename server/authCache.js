// Snellere inlogcontrole (2026-10-09).
//
// Elke API-aanroep vroeg de inlogserver (GoTrue) opnieuw "wie is dit?" (± 0,6 s
// vanaf een laptop, ook live een extra rondgang) en haalde daarna het profiel
// (rol, e-mail) opnieuw op. Dezelfde gebruiker doet dat tientallen keren per
// minuut. Hier onthouden we beide kort:
//  * de gebruiker bij een token: maximaal TTL, en nooit voorbij de vervaltijd
//    van het token zelf (exp). Een verlopen token wordt zonder rondgang
//    geweigerd. Alleen geslaagde controles worden onthouden;
//  * het profiel bij een user-id: maximaal TTL.
// Gevolg: een rolwijziging of een ingetrokken sessie werkt binnen TTL door
// (standaard 30 s) in plaats van direct. Gelijktijdige aanvragen met hetzelfde
// token delen één controle.

import { createHash } from 'node:crypto';

/** Vervaltijd (ms) uit een JWT, zonder de handtekening te controleren; null als onleesbaar. */
export function jwtExpiryMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
}

function bearer(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
  return m ? m[1].trim() : null;
}

export function createTtlCache({ ttlMs = 30000, max = 5000, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (now() >= e.until) { map.delete(key); return undefined; }
      return e.value;
    },
    set(key, value, until = now() + ttlMs) {
      if (map.size >= max) map.delete(map.keys().next().value); // oudste eruit
      map.set(key, { value, until: Math.min(until, now() + ttlMs) });
    },
    delete(key) { map.delete(key); },
    clear() { map.clear(); },
    size: () => map.size,
  };
}

/**
 * Gebruiker bij een Authorization-header, met cache. `verify()` is de echte
 * controle (callerClient.auth.getUser()) en levert { data: { user }, error }.
 * Geeft hetzelfde formaat terug, zodat bestaande code ongewijzigd blijft.
 */
export function createUserCache({ ttlMs = 30000, now = () => Date.now() } = {}) {
  const cache = createTtlCache({ ttlMs, now });
  const inflight = new Map();
  async function getUser(authHeader, verify) {
    const token = bearer(authHeader);
    if (!token) return verify();
    const exp = jwtExpiryMs(token);
    if (exp !== null && exp <= now()) {
      return { data: { user: null }, error: { message: 'Token verlopen', status: 401 } };
    }
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit) return { data: { user: hit }, error: null };
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const r = await verify();
        const user = r?.data?.user;
        if (user && !r.error) cache.set(key, user, exp ?? now() + ttlMs);
        return r;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }
  return { getUser, clear: () => cache.clear(), size: () => cache.size() };
}

/**
 * Profiel (rol, e-mail) bij een user-id, met cache. `load(id)` is de echte
 * query en levert { data, error } (zoals PostgREST). Fouten worden niet onthouden.
 */
export function createProfileCache({ ttlMs = 30000, now = () => Date.now() } = {}) {
  const cache = createTtlCache({ ttlMs, now });
  return {
    async get(userId, load) {
      if (!userId) return load(userId);
      const hit = cache.get(userId);
      if (hit !== undefined) return { data: hit, error: null };
      const r = await load(userId);
      if (!r?.error) cache.set(userId, r?.data ?? null);
      return r;
    },
    invalidate: (userId) => cache.delete(userId),
    clear: () => cache.clear(),
  };
}
