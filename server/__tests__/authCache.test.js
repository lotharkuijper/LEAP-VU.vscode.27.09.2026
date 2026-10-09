// Snellere inlogcontrole (2026-10-09): gebruiker en profiel kort onthouden,
// zonder verlopen tokens of mislukte controles te onthouden.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createUserCache, createProfileCache, jwtExpiryMs } from '../authCache.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (exp) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp })}.sig`;

describe('gebruiker bij een token', () => {
  it('tweede aanvraag binnen de TTL: geen rondgang naar de inlogserver', async () => {
    let t = 1_000_000;
    const cache = createUserCache({ ttlMs: 30000, now: () => t });
    let calls = 0;
    const verify = async () => { calls++; return { data: { user: { id: 'u1' } }, error: null }; };
    const h = `Bearer ${token(Math.floor(t / 1000) + 3600)}`;
    expect((await cache.getUser(h, verify)).data.user.id).toBe('u1');
    expect((await cache.getUser(h, verify)).data.user.id).toBe('u1');
    expect(calls).toBe(1);
    t += 31000;
    await cache.getUser(h, verify);
    expect(calls).toBe(2); // na de TTL opnieuw
  });

  it('nooit langer dan het token geldig is; verlopen token zonder rondgang geweigerd', async () => {
    let t = 1_000_000;
    const cache = createUserCache({ ttlMs: 30000, now: () => t });
    let calls = 0;
    const verify = async () => { calls++; return { data: { user: { id: 'u1' } }, error: null }; };
    const h = `Bearer ${token(Math.floor(t / 1000) + 5)}`; // nog 5 s geldig
    await cache.getUser(h, verify);
    t += 6000;
    const r = await cache.getUser(h, verify);
    expect(r.data.user).toBeNull();
    expect(r.error.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('mislukte controle wordt niet onthouden', async () => {
    const cache = createUserCache({ ttlMs: 30000 });
    let calls = 0;
    const verify = async () => { calls++; return { data: { user: null }, error: { message: 'ongeldig' } }; };
    const h = `Bearer ${token(Math.floor(Date.now() / 1000) + 3600)}`;
    await cache.getUser(h, verify);
    await cache.getUser(h, verify);
    expect(calls).toBe(2);
  });

  it('gelijktijdige aanvragen met hetzelfde token delen één controle', async () => {
    const cache = createUserCache({ ttlMs: 30000 });
    let calls = 0;
    const verify = () => new Promise(r => { calls++; setTimeout(() => r({ data: { user: { id: 'u1' } }, error: null }), 10); });
    const h = `Bearer ${token(Math.floor(Date.now() / 1000) + 3600)}`;
    await Promise.all([cache.getUser(h, verify), cache.getUser(h, verify), cache.getUser(h, verify)]);
    expect(calls).toBe(1);
  });

  it('TTL 0 (tests) = geen cache', async () => {
    const cache = createUserCache({ ttlMs: 0 });
    let calls = 0;
    const verify = async () => { calls++; return { data: { user: { id: 'u1' } }, error: null }; };
    const h = `Bearer ${token(Math.floor(Date.now() / 1000) + 3600)}`;
    await cache.getUser(h, verify);
    await cache.getUser(h, verify);
    expect(calls).toBe(2);
  });

  it('jwtExpiryMs leest exp, en null bij onzin', () => {
    expect(jwtExpiryMs(token(100))).toBe(100000);
    expect(jwtExpiryMs('geen.token')).toBeNull();
  });
});

describe('profiel bij een user-id', () => {
  it('onthouden binnen de TTL, fouten niet', async () => {
    let t = 0;
    const cache = createProfileCache({ ttlMs: 30000, now: () => t });
    let calls = 0;
    const ok = async () => { calls++; return { data: { role: 'docent' }, error: null }; };
    await cache.get('u1', ok);
    expect((await cache.get('u1', ok)).data.role).toBe('docent');
    expect(calls).toBe(1);
    t = 31000;
    await cache.get('u1', ok);
    expect(calls).toBe(2);
    let fails = 0;
    const bad = async () => { fails++; return { data: null, error: { message: 'x' } }; };
    await cache.get('u2', bad); await cache.get('u2', bad);
    expect(fails).toBe(2);
  });
});

describe('server/index.js gebruikt de cache overal', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
  it('geen losse inlogcontroles of profielvragen meer buiten de cache', () => {
    expect(src.match(/await callerClient\.auth\.getUser\(\)/g)).toBeNull();
    expect(src.match(/userCache\.getUser\(authHeader, \(\) => callerClient\.auth\.getUser\(\)\)/g).length).toBeGreaterThan(25);
    const raw = src.match(/supabaseAdmin\s*\.from\('profiles'\)\s*\.select\('role, email'\)\s*\.eq\('id', [^)]+\)\s*\.maybeSingle\(\)/g) || [];
    expect(raw).toHaveLength(1); // alleen de laadfunctie van de cache zelf
  });
});
