// Tokenbudget voor accounts uit open registratie (2026-10-28, migratie
// 20261028100000_token_budget). Beschermt tegen misbruik: iemand die met nep-
// accounts het taalmodel volspamt. VU-, Canvas- en door een docent uitgenodigde
// accounts merken hier niets van.
//
// Raming (bewust ruim): een intensief uur LEAP = 30 aanroepen van het taalmodel
// à ~6.000 tokens (gemeten: chat ~3.500, Ik leg uit ~2.500, bijlage ~6.500 per
// aanroep; een gesprek wordt per beurt duurder) = 180.000 tokens/uur.
//   Weekbudget   14 uur (gemiddeld 1 uur per dag, factor 2) = 2.520.000 tokens
//   Daglimiet    een derde daarvan (tegen een nachtelijke piek)  =   840.000
//   Noodrem      alle open accounts samen per week               = 100.000.000
// De beheerder past dit aan (chatbot_prompts-rij SETTINGS_KEY, Beheer → Instellingen).
//
// Meten: een eigen, kleine meting (los van de Analytics-module, die los
// verwijderbaar moet blijven): een omhulsel om fetch leest `usage` uit de
// antwoorden van Azure OpenAI en schrijft dat bij het lopende verzoek bij.
// Tegenhouden gebeurt alleen bij verzoeken die het taalmodel aanroepen; lezen,
// het leerdagboek, het Studiecafé en gesprekken afsluiten blijven werken.
// Een student ziet zijn eigen percentage; docenten zien niets; de beheerder ziet
// alleen het totaal van alle open accounts.

import { AsyncLocalStorage } from 'node:async_hooks';

export const SETTINGS_KEY = '__token_budget__';
export const TOKENS_PER_HOUR = 180_000;
export const DEFAULT_SETTINGS = Object.freeze({
  weekTokens: 14 * TOKENS_PER_HOUR,
  dayTokens: Math.round((14 * TOKENS_PER_HOUR) / 3),
  openWeekTotal: 100_000_000,
  alertAt: 0.8,
  registrationsPerHourAlert: 20,
});
const TZ = 'Europe/Amsterdam';
const CACHE_MS = 30_000;

// Verzoeken die het taalmodel aanroepen en bij een vol budget worden tegengehouden.
const AI_PATHS = [
  /^\/api\/chat$/,
  /^\/api\/chat\/reflect$/,
  /^\/api\/chat\/attachments\/extract$/,
  /^\/api\/explain\/(evaluate|improve\/create|improve\/evaluate|improve\/reflect)$/,
  /^\/api\/projects\/persona-chat$/,
  /^\/api\/projects\/groups\/[^/]+\/(checkpoint|checkpoint-preview|evaluate)$/,
  /^\/api\/projects\/groups\/[^/]+\/threads\/[^/]+\/close-preview$/,
  /^\/api\/projects\/[^/]+\/groups\/[^/]+\/personas\/[^/]+\/feedback$/,
  /^\/api\/projects\/(save-summary)$/,
  /^\/api\/quiz\/save-summary$/,
  /^\/api\/rag\/documents\/[^/]+\/translate$/,
];

export function isAiRequest(method, path) {
  if (String(method).toUpperCase() !== 'POST') return false;
  const p = String(path || '').split('?')[0];
  return AI_PATHS.some((re) => re.test(p));
}

const int = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const weekTokens = int(r.weekTokens, 10_000, 1_000_000_000, DEFAULT_SETTINGS.weekTokens);
  return {
    weekTokens,
    dayTokens: int(r.dayTokens, 10_000, weekTokens, Math.min(DEFAULT_SETTINGS.dayTokens, weekTokens)),
    openWeekTotal: int(r.openWeekTotal, 100_000, 100_000_000_000, DEFAULT_SETTINGS.openWeekTotal),
    alertAt: DEFAULT_SETTINGS.alertAt,
    registrationsPerHourAlert: int(r.registrationsPerHourAlert, 1, 10_000, DEFAULT_SETTINGS.registrationsPerHourAlert),
  };
}

/** Kalenderdag in Amsterdam als 'YYYY-MM-DD'. */
export function amsterdamDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Maandag van de week waarin `day` ('YYYY-MM-DD') valt. */
export function weekStartDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const back = (dt.getUTCDay() + 6) % 7; // ma = 0
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

/** Percentages en of er iets dicht staat. blocked: 'global' | 'week' | 'day' | null. */
export function budgetState({ day = 0, week = 0, openTotal = 0 }, settings) {
  const s = normalizeSettings(settings);
  const pct = (a, b) => Math.min(100, Math.floor((100 * a) / Math.max(1, b)));
  let blocked = null;
  if (openTotal >= s.openWeekTotal) blocked = 'global';
  else if (week >= s.weekTokens) blocked = 'week';
  else if (day >= s.dayTokens) blocked = 'day';
  return { blocked, dayPercent: pct(day, s.dayTokens), weekPercent: pct(week, s.weekTokens) };
}

export const BLOCK_MESSAGES = {
  day: 'Je hebt je AI-gebruik voor vandaag bereikt. Morgen kun je weer verder.',
  week: 'Je hebt je AI-gebruik voor deze week bereikt. Maandag kun je weer verder.',
  global: 'De AI-onderdelen zijn voor accounts met open registratie tijdelijk gepauzeerd. Probeer het later opnieuw.',
};

/** Is dit een aanroep naar Azure OpenAI (chat of embeddings)? */
export function isLlmUrl(url) {
  return /\/openai\/deployments\/[^/]+\/(chat\/completions|embeddings)\b/.test(String(url || ''));
}

/**
 * deps: getDb(), getUser(authHeader) → user | null, requireAdmin(req, res) → user | null,
 *       sendAlert({ subject, text }) (mail aan de beheerders), now() (tests), target (fetch-doel, tests)
 */
export function installTokenBudget(app, deps) {
  const als = new AsyncLocalStorage();
  const now = deps.now || (() => new Date());
  const openCache = new Map();
  const usageCache = new Map();
  let settingsCache = { value: null, exp: 0 };
  let totalCache = { from: null, total: 0, exp: 0 };
  const alerted = new Set(); // per week/uur één mail (procesgeheugen: één replica)

  const db = () => deps.getDb();

  async function settings() {
    if (settingsCache.value && settingsCache.exp > Date.now()) return settingsCache.value;
    let value = normalizeSettings(null);
    try {
      const { data } = await db().from('chatbot_prompts').select('content').eq('name', SETTINGS_KEY).maybeSingle();
      if (data?.content) value = normalizeSettings(JSON.parse(data.content));
    } catch { /* standaard */ }
    settingsCache = { value, exp: Date.now() + CACHE_MS };
    return value;
  }

  async function isOpen(userId) {
    const c = openCache.get(userId);
    if (c && c.exp > Date.now()) return c.open;
    let open = false;
    try {
      const { data } = await db().from('open_accounts').select('user_id').eq('user_id', userId).maybeSingle();
      open = !!data;
    } catch { open = false; } // tabel ontbreekt: geen budget (nooit iets breken)
    openCache.set(userId, { open, exp: Date.now() + 5 * 60_000 });
    return open;
  }

  async function usageOf(userId) {
    const today = amsterdamDay(now());
    const from = weekStartDay(today);
    const c = usageCache.get(userId);
    if (c && c.exp > Date.now() && c.from === from) return c;
    const { data } = await db().from('token_usage').select('day, tokens').eq('user_id', userId).gte('day', from);
    const week = (data || []).reduce((n, r) => n + Number(r.tokens || 0), 0);
    const day = (data || []).filter((r) => r.day === today).reduce((n, r) => n + Number(r.tokens || 0), 0);
    const v = { from, week, day, exp: Date.now() + CACHE_MS };
    usageCache.set(userId, v);
    return v;
  }

  async function openTotal() {
    const from = weekStartDay(amsterdamDay(now()));
    if (totalCache.from === from && totalCache.exp > Date.now()) return totalCache.total;
    const { data, error } = await db().rpc('leap_open_token_total', { p_from: from });
    const total = error ? 0 : Number(data || 0);
    totalCache = { from, total, exp: Date.now() + 60_000 };
    return total;
  }

  async function stateFor(userId) {
    const [s, u, total] = await Promise.all([settings(), usageOf(userId), openTotal()]);
    return { ...budgetState({ day: u.day, week: u.week, openTotal: total }, s), settings: s, usage: u, openTotal: total };
  }

  async function alertOnce(key, subject, text) {
    if (alerted.has(key)) return;
    alerted.add(key);
    try { await deps.sendAlert?.({ subject, text }); } catch (e) { console.warn('[token-budget] melding niet verstuurd:', e?.message); }
  }

  async function credit(store, tokens) {
    if (!store?.auth || !(tokens > 0)) return;
    if (store.userId === undefined) {
      const user = await deps.getUser(store.auth).catch(() => null);
      store.userId = user && (await isOpen(user.id)) ? user.id : null;
    }
    if (!store.userId) return;
    const day = amsterdamDay(now());
    const { error } = await db().rpc('leap_add_token_usage', { p_user: store.userId, p_day: day, p_tokens: Math.round(tokens) });
    if (error) { console.warn('[token-budget] tokens niet bijgeschreven:', error.message); return; }
    usageCache.delete(store.userId);
    if (totalCache.from === weekStartDay(day)) totalCache.total += tokens;
    const s = await settings();
    if (totalCache.total >= s.alertAt * s.openWeekTotal) {
      const pct = Math.floor((100 * totalCache.total) / s.openWeekTotal);
      await alertOnce(`total:${totalCache.from}:${pct >= 100 ? 100 : 80}`,
        `LEAP: AI-gebruik open accounts op ${pct}% van de noodrem`,
        `Alle accounts uit open registratie samen gebruikten deze week ${totalCache.total.toLocaleString('nl-NL')} tokens; de noodrem staat op ${s.openWeekTotal.toLocaleString('nl-NL')}.${pct >= 100 ? ' De AI-onderdelen zijn voor deze accounts gepauzeerd tot maandag.' : ''} Aanpassen: Beheer → Instellingen.`);
    }
  }

  // Meting: elk antwoord van Azure OpenAI bij het lopende verzoek optellen.
  const target = deps.target || globalThis;
  const orig = target.fetch;
  if (typeof orig === 'function' && !orig.__leapTokenBudget) {
    const metered = async function budgetFetch(input, init) {
      const res = await orig(input, init);
      try {
        const store = als.getStore();
        const url = typeof input === 'string' ? input : (input?.url || String(input));
        const type = res?.headers?.get?.('content-type') || '';
        if (store?.auth && res?.ok && isLlmUrl(url) && type.includes('json') && typeof res.clone === 'function') {
          res.clone().json().then((j) => {
            const u = j?.usage;
            const tokens = Number(u?.total_tokens ?? ((u?.prompt_tokens || 0) + (u?.completion_tokens || 0)));
            if (tokens > 0) credit(store, tokens).catch(() => {});
          }).catch(() => {});
        }
      } catch { /* meten mag nooit iets breken */ }
      return res;
    };
    metered.__leapTokenBudget = true;
    target.fetch = metered;
  }

  // Tegenhouden vóór de route, alleen bij AI-verzoeken van open accounts.
  app.use('/api', async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth) return next();
    const store = { auth, userId: undefined };
    try {
      if (isAiRequest(req.method, req.originalUrl)) {
        const user = await deps.getUser(auth).catch(() => null);
        store.userId = user && (await isOpen(user.id)) ? user.id : null;
        if (store.userId) {
          const st = await stateFor(store.userId);
          if (st.blocked) {
            return res.status(429).json({ error: BLOCK_MESSAGES[st.blocked], code: 'tokenBudget', scope: st.blocked, dayPercent: st.dayPercent, weekPercent: st.weekPercent });
          }
        }
      }
    } catch { /* bij twijfel nooit tegenhouden */ }
    return als.run(store, next);
  });

  // De student: eigen verbruik in procenten (alleen bij een open account).
  app.get('/api/me/token-budget', async (req, res) => {
    const user = req.headers.authorization ? await deps.getUser(req.headers.authorization).catch(() => null) : null;
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await isOpen(user.id))) return res.json({ applies: false });
    const st = await stateFor(user.id);
    return res.json({ applies: true, dayPercent: st.dayPercent, weekPercent: st.weekPercent, blocked: st.blocked });
  });

  // De beheerder: instellingen en het totaal van alle open accounts (nooit per persoon).
  app.get('/api/admin/token-budget', async (req, res) => {
    if (!(await deps.requireAdmin(req, res))) return;
    const [s, total] = await Promise.all([settings(), openTotal()]);
    const { count } = await db().from('open_accounts').select('user_id', { count: 'exact', head: true });
    return res.json({ settings: s, defaults: DEFAULT_SETTINGS, openWeekUsed: total, openAccounts: count || 0, tokensPerHour: TOKENS_PER_HOUR });
  });
  app.put('/api/admin/token-budget', async (req, res) => {
    const admin = await deps.requireAdmin(req, res);
    if (!admin) return;
    const next = normalizeSettings({ ...(await settings()), ...(req.body || {}) });
    const content = JSON.stringify(next);
    const { data: row } = await db().from('chatbot_prompts').select('id, content').eq('name', SETTINGS_KEY).maybeSingle();
    const { error } = row
      ? await db().from('chatbot_prompts').update({ content }).eq('id', row.id)
      : await db().from('chatbot_prompts').insert({ name: SETTINGS_KEY, content, is_active: false });
    if (error) return res.status(500).json({ error: error.message });
    try {
      await db().from('leap_setting_changes').insert({
        course_id: null, setting: SETTINGS_KEY,
        value: { from: row?.content ? JSON.parse(row.content) : null, to: next }, changed_by: admin.id,
      });
    } catch { /* logboek is aanvullend */ }
    settingsCache = { value: null, exp: 0 };
    return res.json({ settings: next });
  });

  /** Open registratie: account markeren, en de beheerder waarschuwen bij een ongewone piek. */
  async function markOpenAccount(userId) {
    try {
      await db().from('open_accounts').upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
      openCache.delete(userId);
      const since = new Date(now().getTime() - 3_600_000).toISOString();
      const { count } = await db().from('open_accounts').select('user_id', { count: 'exact', head: true }).gte('registered_at', since);
      const s = await settings();
      if ((count || 0) >= s.registrationsPerHourAlert) {
        await alertOnce(`reg:${since.slice(0, 13)}`, 'LEAP: ongewoon veel open registraties',
          `In het afgelopen uur kwamen er ${count} accounts bij via open registratie (drempel: ${s.registrationsPerHourAlert}). Controleer of dit klopt; de tokenlimieten blijven gelden.`);
      }
    } catch (e) {
      console.warn('[token-budget] open account niet gemarkeerd:', e?.message);
    }
  }

  return { markOpenAccount, isAiRequest };
}
