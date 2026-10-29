import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  installTokenBudget, isAiRequest, normalizeSettings, budgetState, weekStartDay, amsterdamDay,
  isLlmUrl, DEFAULT_SETTINGS, TOKENS_PER_HOUR, SETTINGS_KEY,
} from '../account/tokenBudget.js';

// Tokenbudget voor accounts uit open registratie (2026-10-28).

describe('rekenregels', () => {
  it('standaard = 14 uur intensief werken per week, daglimiet een derde daarvan', () => {
    expect(DEFAULT_SETTINGS.weekTokens).toBe(14 * TOKENS_PER_HOUR);
    expect(DEFAULT_SETTINGS.weekTokens).toBe(2_520_000);
    expect(DEFAULT_SETTINGS.dayTokens).toBe(840_000);
  });

  it('instellingen worden begrensd; daglimiet nooit boven het weekbudget', () => {
    const s = normalizeSettings({ weekTokens: 50_000, dayTokens: 9_999_999, openWeekTotal: 'x', registrationsPerHourAlert: 0 });
    expect(s.weekTokens).toBe(50_000);
    expect(s.dayTokens).toBe(50_000);
    expect(s.openWeekTotal).toBe(DEFAULT_SETTINGS.openWeekTotal);
    expect(s.registrationsPerHourAlert).toBe(1);
  });

  it('noodrem gaat voor week, week voor dag', () => {
    const s = { weekTokens: 1_000_000, dayTokens: 100_000, openWeekTotal: 5_000_000 };
    expect(budgetState({ day: 0, week: 0, openTotal: 5_000_000 }, s).blocked).toBe('global');
    expect(budgetState({ day: 200_000, week: 1_000_000, openTotal: 0 }, s).blocked).toBe('week');
    expect(budgetState({ day: 100_000, week: 100_000, openTotal: 0 }, s).blocked).toBe('day');
    const ok = budgetState({ day: 50_000, week: 250_000, openTotal: 0 }, s);
    expect(ok).toEqual({ blocked: null, dayPercent: 50, weekPercent: 25 });
  });

  it('week begint op maandag (Amsterdamse tijd)', () => {
    expect(weekStartDay('2026-10-28')).toBe('2026-10-26'); // woensdag
    expect(weekStartDay('2026-10-26')).toBe('2026-10-26'); // maandag
    expect(weekStartDay('2026-11-01')).toBe('2026-10-26'); // zondag
    expect(amsterdamDay(new Date('2026-10-27T23:30:00Z'))).toBe('2026-10-28');
  });

  it('alleen AI-verzoeken (POST) vallen onder het budget; afronden en opslaan niet', () => {
    expect(isAiRequest('POST', '/api/chat')).toBe(true);
    expect(isAiRequest('POST', '/api/explain/improve/create')).toBe(true);
    expect(isAiRequest('POST', '/api/projects/persona-chat?x=1')).toBe(true);
    expect(isAiRequest('GET', '/api/chat')).toBe(false);
    expect(isAiRequest('POST', '/api/projects/groups/g1/threads/t1/close')).toBe(false);
    expect(isAiRequest('POST', '/api/projects/groups/g1/journal-save')).toBe(false);
    expect(isAiRequest('POST', '/api/studiecafe/c1/threads')).toBe(false);
  });

  it('herkent Azure OpenAI-aanroepen', () => {
    expect(isLlmUrl('https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=1')).toBe(true);
    expect(isLlmUrl('https://x.openai.azure.com/openai/deployments/emb/embeddings')).toBe(true);
    expect(isLlmUrl('https://example.org/api/chat')).toBe(false);
  });
});

// Kleine nep-database: genoeg van de Supabase-builder voor deze module.
function fakeDb() {
  const tables = { open_accounts: [], token_usage: [], chatbot_prompts: [], leap_setting_changes: [] };
  const from = (name) => {
    const rows = tables[name];
    const filters = [];
    let op = 'select';
    let payload = null;
    let head = false;
    const match = (r) => filters.every((f) => f(r));
    const q = {
      select: (_c, opts) => { if (opts?.head) head = true; return q; },
      eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
      gte: (k, v) => { filters.push((r) => r[k] >= v); return q; },
      upsert: (row) => { if (!rows.some((r) => r.user_id === row.user_id)) rows.push({ registered_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null }); },
      insert: (row) => { rows.push({ id: String(rows.length + 1), ...row }); return Promise.resolve({ error: null }); },
      update: (p) => { op = 'update'; payload = p; return q; },
      maybeSingle: () => Promise.resolve({ data: rows.find(match) || null, error: null }),
      then: (res, rej) => {
        if (op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, payload)); return Promise.resolve({ error: null }).then(res, rej); }
        const data = rows.filter(match);
        return Promise.resolve(head ? { count: data.length, error: null } : { data, error: null }).then(res, rej);
      },
    };
    return q;
  };
  const rpc = async (fn, args) => {
    if (fn === 'leap_add_token_usage') {
      const r = tables.token_usage.find((x) => x.user_id === args.p_user && x.day === args.p_day);
      if (r) r.tokens += args.p_tokens; else tables.token_usage.push({ user_id: args.p_user, day: args.p_day, tokens: args.p_tokens });
      return { data: null, error: null };
    }
    if (fn === 'leap_open_token_total') {
      const open = new Set(tables.open_accounts.map((a) => a.user_id));
      return { data: tables.token_usage.filter((r) => open.has(r.user_id) && r.day >= args.p_from).reduce((n, r) => n + r.tokens, 0), error: null };
    }
    return { data: null, error: { message: 'onbekend' } };
  };
  return { tables, from, rpc };
}

describe('installTokenBudget', () => {
  let server; let base; let db; let alerts; let llmTokens;
  const users = { 'Bearer open': { id: 'u-open' }, 'Bearer vu': { id: 'u-vu' }, 'Bearer admin': { id: 'u-admin' } };

  beforeEach(async () => {
    db = fakeDb();
    db.tables.open_accounts.push({ user_id: 'u-open', registered_at: new Date().toISOString() });
    alerts = [];
    llmTokens = 1000;
    const target = {
      fetch: async () => new Response(JSON.stringify({ usage: { total_tokens: llmTokens } }), { headers: { 'content-type': 'application/json' } }),
    };
    const app = express();
    app.use(express.json());
    const tb = installTokenBudget(app, {
      getDb: () => db,
      getUser: async (a) => users[a] || null,
      requireAdmin: async (req, res) => (req.headers.authorization === 'Bearer admin' ? users['Bearer admin'] : (res.status(403).json({ error: 'nee' }), null)),
      sendAlert: async (m) => { alerts.push(m); },
      target,
    });
    app.post('/api/chat', async (_req, res) => {
      await target.fetch('https://x.openai.azure.com/openai/deployments/gpt/chat/completions');
      res.json({ ok: true });
    });
    app.locals.tb = tb;
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const post = (who, p = '/api/chat') => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: '{}' });
  const get = (who, p) => fetch(base + p, { headers: { authorization: `Bearer ${who}` } }).then((r) => r.json());
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('telt tokens alleen voor open accounts', async () => {
    await post('open'); await post('vu'); await settle();
    expect(db.tables.token_usage).toEqual([{ user_id: 'u-open', day: amsterdamDay(), tokens: 1000 }]);
  });

  it('student ziet procenten; andere accounts zien niets', async () => {
    llmTokens = 84_000; // 10% van de daglimiet
    await post('open'); await settle();
    expect(await get('open', '/api/me/token-budget')).toEqual({ applies: true, dayPercent: 10, weekPercent: 3, blocked: null });
    expect(await get('vu', '/api/me/token-budget')).toEqual({ applies: false });
  });

  it('houdt een open account tegen boven de daglimiet, maar nooit een ander account', async () => {
    db.tables.token_usage.push({ user_id: 'u-open', day: amsterdamDay(), tokens: DEFAULT_SETTINGS.dayTokens });
    db.tables.token_usage.push({ user_id: 'u-vu', day: amsterdamDay(), tokens: 50_000_000 });
    const r = await post('open');
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'tokenBudget', scope: 'day' });
    expect((await post('vu')).status).toBe(200);
  });

  it('noodrem: alle open accounts samen boven het totaal → pauze en een mail aan de beheerder', async () => {
    db.tables.chatbot_prompts.push({ id: '1', name: SETTINGS_KEY, content: JSON.stringify({ openWeekTotal: 100_000 }) });
    llmTokens = 100_000;
    await post('open'); await settle();
    expect(alerts.length).toBe(1);
    expect(alerts[0].subject).toMatch(/noodrem/);
  });

  it('beheerder ziet alleen totalen en kan instellingen wijzigen (gelogd)', async () => {
    const before = await get('admin', '/api/admin/token-budget');
    expect(before).toMatchObject({ openAccounts: 1, openWeekUsed: 0, tokensPerHour: TOKENS_PER_HOUR });
    expect(JSON.stringify(before)).not.toMatch(/u-open/);
    const r = await fetch(base + '/api/admin/token-budget', { method: 'PUT', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify({ weekTokens: 500_000 }) });
    expect((await r.json()).settings.weekTokens).toBe(500_000);
    expect(db.tables.leap_setting_changes[0]).toMatchObject({ setting: SETTINGS_KEY, changed_by: 'u-admin' });
    const denied = await fetch(base + '/api/admin/token-budget', { headers: { authorization: 'Bearer open' } });
    expect(denied.status).toBe(403);
  });

  it('markOpenAccount markeert en waarschuwt bij een piek in registraties', async () => {
    db.tables.chatbot_prompts.push({ id: '1', name: SETTINGS_KEY, content: JSON.stringify({ registrationsPerHourAlert: 2 }) });
    const tb = server.listeners('request')[0].locals.tb;
    await tb.markOpenAccount('u-new');
    expect(db.tables.open_accounts.map((a) => a.user_id)).toContain('u-new');
    expect(alerts.some((a) => /registraties/.test(a.subject))).toBe(true);
  });
});

describe('aansluiting', () => {
  const src = (f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  it('open registratie markeert het account', () => {
    expect(src('server/courses/enrollment.js')).toMatch(/onOpenRegistration\?\.\(/);
    expect(src('server/index.js')).toMatch(/onOpenRegistration: \(userId\) => tokenBudget\.markOpenAccount\(userId\)/);
  });
  it('wegwerpadressen worden geweigerd', async () => {
    const { isDisposableEmail } = await import('../courses/enrollment.js');
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
  });
});
