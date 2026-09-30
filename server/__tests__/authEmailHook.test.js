import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import { verifyHookSignature, buildVerifyLink, buildAuthEmail, registerAuthEmailHook } from '../authEmailHook.js';

const KEY = crypto.randomBytes(32);
const SECRET = `v1,whsec_${KEY.toString('base64')}`;

// Ondertekent zoals de inlogdienst dat doet (Standard Webhooks).
function sign(body, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), key = KEY } = {}) {
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` };
}

const payload = (type = 'signup', extra = {}) => ({
  user: { id: 'u1', email: 'student@student.vu.nl', user_metadata: { full_name: 'Sam de Vries' } },
  email_data: {
    token: '123456',
    token_hash: 'abc123hash',
    redirect_to: 'https://leap.example/reset-password',
    email_action_type: type,
    site_url: 'https://leap.example',
    ...extra,
  },
});

describe('verifyHookSignature', () => {
  const body = JSON.stringify(payload());

  it('accepteert een geldige handtekening', () => {
    expect(verifyHookSignature({ secret: SECRET, headers: sign(body), rawBody: body })).toBe(true);
  });

  it('weigert een gewijzigde body, een verkeerde sleutel en ontbrekende headers', () => {
    expect(verifyHookSignature({ secret: SECRET, headers: sign(body), rawBody: body + ' ' })).toBe(false);
    expect(verifyHookSignature({ secret: SECRET, headers: sign(body, { key: crypto.randomBytes(32) }), rawBody: body })).toBe(false);
    expect(verifyHookSignature({ secret: SECRET, headers: {}, rawBody: body })).toBe(false);
    expect(verifyHookSignature({ secret: '', headers: sign(body), rawBody: body })).toBe(false);
  });

  it('weigert een oude aanroep (herhaling)', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyHookSignature({ secret: SECRET, headers: sign(body, { ts: old }), rawBody: body })).toBe(false);
  });

  it('accepteert elk van meerdere geheimen en meerdere handtekeningen', () => {
    const other = `v1,whsec_${crypto.randomBytes(32).toString('base64')}`;
    const headers = sign(body);
    headers['webhook-signature'] = `v1,${crypto.randomBytes(32).toString('base64')} ${headers['webhook-signature']}`;
    expect(verifyHookSignature({ secret: `${other}|${SECRET}`, headers, rawBody: body })).toBe(true);
  });
});

describe('buildAuthEmail', () => {
  const opts = { lang: 'nl', supabaseUrl: 'https://supabase.example/', appUrl: 'https://leap.example', userName: 'Sam' };

  it('bouwt de bevestigingslink via de inlogdienst, met doorsturen naar de app', () => {
    const link = buildVerifyLink({ supabaseUrl: opts.supabaseUrl, emailData: payload('recovery').email_data });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://supabase.example/auth/v1/verify');
    expect(url.searchParams.get('token')).toBe('abc123hash');
    expect(url.searchParams.get('type')).toBe('recovery');
    expect(url.searchParams.get('redirect_to')).toBe('https://leap.example/reset-password');
  });

  it('valt zonder redirect_to terug op het adres van de app', () => {
    const link = buildVerifyLink({
      supabaseUrl: opts.supabaseUrl,
      emailData: { token_hash: 'h', email_action_type: 'signup' },
      appUrl: 'https://leap.example',
    });
    expect(new URL(link).searchParams.get('redirect_to')).toBe('https://leap.example');
  });

  it('heeft per soort e-mail een eigen tekst, in de taal van de gebruiker', () => {
    const signup = buildAuthEmail(payload('signup').email_data, opts);
    const invite = buildAuthEmail(payload('invite').email_data, opts);
    const recovery = buildAuthEmail(payload('recovery').email_data, { ...opts, lang: 'en' });
    expect(signup.subject).toBe('Bevestig je e-mailadres voor LEAP');
    expect(invite.subject).toBe('Je bent uitgenodigd voor LEAP');
    expect(recovery.subject).toBe('Set a new password for LEAP');
    expect(signup.text).toContain('Hoi Sam,');
    expect(signup.html).toContain('abc123hash');
    expect(signup.text).toContain('/auth/v1/verify?token=abc123hash&type=signup');
  });

  it('geeft een onbekende soort de algemene tekst in plaats van een lege e-mail', () => {
    const mail = buildAuthEmail(payload('email_change').email_data, opts);
    expect(mail.subject).toBe('Bevestig je verzoek voor LEAP');
  });

  it('heeft de teksten in elke taal (geen kale sleutels)', async () => {
    const { SUPPORTED_LANG_CODES } = await import('../languages.js');
    for (const lang of SUPPORTED_LANG_CODES) {
      for (const type of ['signup', 'invite', 'recovery', 'magiclink']) {
        const mail = buildAuthEmail(payload(type).email_data, { ...opts, lang });
        expect(mail.subject, `${lang}/${type}`).not.toMatch(/^email\./);
        expect(mail.text, `${lang}/${type}`).not.toMatch(/email\.auth\./);
      }
    }
  });

  it('ontsnapt HTML in de naam', () => {
    const mail = buildAuthEmail(payload().email_data, { ...opts, userName: '<b>x</b>' });
    expect(mail.html).not.toContain('<b>x</b>');
  });
});

describe('POST /api/auth/email-hook', () => {
  async function start(deps) {
    const app = express();
    const registered = registerAuthEmailHook(app, express, {
      secret: SECRET,
      supabaseUrl: 'https://supabase.example',
      appUrl: () => 'https://leap.example',
      getLang: async () => 'nl',
      getEmailConfig: async () => ({ provider: 'acs', connectionString: 'x', from: 'leap@vu-edulab.nl' }),
      sendEmail: async () => ({ ok: true, status: 202 }),
      ...deps,
    });
    // Net als in server/index.js: de JSON-parser komt ná de hook.
    app.use(express.json());
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/auth/email-hook`;
    return { registered, url, close: () => new Promise((r) => server.close(r)) };
  }
  const post = (url, body, headers) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  it('verstuurt de e-mail bij een geldig ondertekende aanroep', async () => {
    const sendEmail = vi.fn(async () => ({ ok: true, status: 202 }));
    const { url, close } = await start({ sendEmail });
    try {
      const body = JSON.stringify(payload('invite'));
      const resp = await post(url, body, sign(body));
      expect(resp.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [cfg, msg, opts] = sendEmail.mock.calls[0];
      expect(opts).toEqual({ wait: false });
      expect(cfg.provider).toBe('acs');
      expect(msg.to).toBe('student@student.vu.nl');
      expect(msg.subject).toBe('Je bent uitgenodigd voor LEAP');
      expect(msg.text).toContain('type=invite');
    } finally { await close(); }
  });

  it('verstuurt niets zonder geldige handtekening', async () => {
    const sendEmail = vi.fn();
    const { url, close } = await start({ sendEmail });
    try {
      const body = JSON.stringify(payload());
      expect((await post(url, body, {})).status).toBe(401);
      expect((await post(url, body, sign(body + 'x'))).status).toBe(401);
      expect(sendEmail).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('meldt een fout aan de inlogdienst als versturen mislukt of e-mail niet is ingesteld', async () => {
    const body = JSON.stringify(payload());
    let ctx = await start({ sendEmail: async () => ({ ok: false, status: 403, error: 'ErrorAccessDenied' }) });
    try {
      const resp = await post(ctx.url, body, sign(body));
      expect(resp.status).toBe(502);
      expect((await resp.json()).error.http_code).toBe(502);
    } finally { await ctx.close(); }
    ctx = await start({ getEmailConfig: async () => null });
    try {
      expect((await post(ctx.url, body, sign(body))).status).toBe(503);
    } finally { await ctx.close(); }
  });

  it('bestaat niet zonder geheim (Replit/Supabase-cloud: Supabase mailt zelf)', () => {
    const app = express();
    expect(registerAuthEmailHook(app, express, { secret: '' })).toBe(false);
  });
});
