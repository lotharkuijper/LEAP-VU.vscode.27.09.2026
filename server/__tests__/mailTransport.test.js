import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  getEmailConfig,
  sendEmail,
  sendEmailViaAcs,
  parseAcsConnectionString,
  acsSignedHeaders,
} from '../notifications.js';

const KEY = crypto.randomBytes(32).toString('base64');
const CONN = `endpoint=https://vu-leap-acs.europe.communication.azure.com/;accesskey=${KEY}`;
const azureEnv = { ACS_CONNECTION_STRING: CONN, ACS_SENDER: 'leap@vu-edulab.nl', MAIL_REPLY_TO: 'antwoord@vu.nl' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const mail = { connectionString: CONN, from: 'leap@vu-edulab.nl', replyTo: 'antwoord@vu.nl', to: 'student@student.vu.nl', subject: 'Onderwerp', html: '<p>Hoi</p>', text: 'Hoi' };

describe('getEmailConfig', () => {
  it('kiest ACS zodra de verbinding en de afzender zijn ingesteld', async () => {
    expect(await getEmailConfig(azureEnv)).toEqual({
      provider: 'acs',
      connectionString: CONN,
      from: 'leap@vu-edulab.nl',
      replyTo: 'antwoord@vu.nl',
    });
  });
  it('blijft bij Resend als alleen de afzender is gezet', async () => {
    const cfg = await getEmailConfig({ ACS_SENDER: 'leap@vu-edulab.nl', RESEND_API_KEY: 're_1' });
    expect(cfg).toEqual({ provider: 'resend', apiKey: 're_1', from: 'Studiecafé <onboarding@resend.dev>' });
  });
  it('geeft null zonder enige configuratie, zodat de wachtrij blijft staan', async () => {
    expect(await getEmailConfig({})).toBeNull();
  });
});

describe('parseAcsConnectionString', () => {
  it('leest eindpunt en sleutel (de sleutel bevat zelf "=")', () => {
    expect(parseAcsConnectionString(CONN)).toEqual({
      endpoint: 'https://vu-leap-acs.europe.communication.azure.com',
      accessKey: KEY,
    });
  });
  it('geeft null bij een onvolledige waarde', () => {
    expect(parseAcsConnectionString('endpoint=https://x/')).toBeNull();
    expect(parseAcsConnectionString('')).toBeNull();
  });
});

describe('acsSignedHeaders', () => {
  it('ondertekent methode, pad, datum, host en body-hash met de toegangssleutel', () => {
    const date = new Date('2026-09-30T12:00:00Z');
    const url = 'https://vu-leap-acs.europe.communication.azure.com/emails:send?api-version=2023-03-31';
    const body = '{"a":1}';
    const h = acsSignedHeaders({ method: 'POST', url, body, accessKey: KEY, date });
    const hash = crypto.createHash('sha256').update(body).digest('base64');
    const expected = crypto
      .createHmac('sha256', Buffer.from(KEY, 'base64'))
      .update(`POST\n/emails:send?api-version=2023-03-31\nWed, 30 Sep 2026 12:00:00 GMT;vu-leap-acs.europe.communication.azure.com;${hash}`)
      .digest('base64');
    expect(h['x-ms-date']).toBe('Wed, 30 Sep 2026 12:00:00 GMT');
    expect(h['x-ms-content-sha256']).toBe(hash);
    expect(h.Authorization).toBe(`HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expected}`);
  });
});

describe('sendEmailViaAcs', () => {
  it('verstuurt vanaf de afzender, met antwoordadres, en volgt de afhandeling tot die gelukt is', async () => {
    const states = ['Running', 'Succeeded'];
    const fetchImpl = vi.fn(async (url, init) =>
      init.method === 'POST' ? json(202, { id: 'op-1', status: 'Running' }) : json(200, { id: 'op-1', status: states.shift() }));
    const result = await sendEmailViaAcs(mail, { fetchImpl, pollMs: 1 });
    expect(result).toEqual({ ok: true, status: 202 });

    const [sendUrl, sendInit] = fetchImpl.mock.calls[0];
    expect(sendUrl).toBe('https://vu-leap-acs.europe.communication.azure.com/emails:send?api-version=2023-03-31');
    expect(sendInit.headers.Authorization).toMatch(/^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
    expect(JSON.parse(sendInit.body)).toEqual({
      senderAddress: 'leap@vu-edulab.nl',
      content: { subject: 'Onderwerp', plainText: 'Hoi', html: '<p>Hoi</p>' },
      recipients: { to: [{ address: 'student@student.vu.nl' }] },
      replyTo: [{ address: 'antwoord@vu.nl' }],
    });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://vu-leap-acs.europe.communication.azure.com/emails/operations/op-1?api-version=2023-03-31');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('telt een e-mail die ACS na aannemen weigert niet als verzonden', async () => {
    const fetchImpl = vi.fn(async (url, init) =>
      init.method === 'POST'
        ? json(202, { id: 'op-2' })
        : json(200, { id: 'op-2', status: 'Failed', error: { message: 'EmailDroppedAllRecipientsSuppressed' } }));
    const result = await sendEmailViaAcs(mail, { fetchImpl, pollMs: 1 });
    expect(result).toEqual({ ok: false, status: 502, error: 'EmailDroppedAllRecipientsSuppressed' });
  });

  it('geeft een geweigerd verzoek (bv. onbekende afzender, limiet) terug als fout', async () => {
    const denied = vi.fn(async () => json(401, { error: { code: 'Denied' } }));
    const r1 = await sendEmailViaAcs(mail, { fetchImpl: denied });
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(401);
    const limited = vi.fn(async () => json(429, { error: { code: 'TooManyRequests' } }));
    expect((await sendEmailViaAcs(mail, { fetchImpl: limited })).status).toBe(429);
  });

  it('wacht niet op de afhandeling met wait: false', async () => {
    const fetchImpl = vi.fn(async () => json(202, { id: 'op-3' }));
    expect(await sendEmailViaAcs(mail, { wait: false, fetchImpl })).toEqual({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('geeft een fout terug in plaats van te gooien (wachtrij blijft staan)', async () => {
    const broken = vi.fn(async () => { throw new Error('netwerk weg'); });
    expect(await sendEmailViaAcs(mail, { fetchImpl: broken })).toEqual({ ok: false, status: 0, error: 'netwerk weg' });
    expect((await sendEmailViaAcs({ ...mail, connectionString: 'onzin' })).ok).toBe(false);
  });
});

describe('sendEmail', () => {
  it('laat geen ontvangers, onderwerp of tekst vallen tussen configuratie en transport', async () => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push({ url, init }); return json(202, { id: 'op-4' }); };
    try {
      const cfg = await getEmailConfig(azureEnv);
      const result = await sendEmail(cfg, { to: 'a@student.vu.nl', subject: 'S', html: '<p>H</p>', text: 'T' }, { wait: false });
      expect(result.ok).toBe(true);
      const body = JSON.parse(seen[0].init.body);
      expect(body.senderAddress).toBe('leap@vu-edulab.nl');
      expect(body.recipients.to[0].address).toBe('a@student.vu.nl');
      expect(body.content).toEqual({ subject: 'S', plainText: 'T', html: '<p>H</p>' });
      expect(body.replyTo).toEqual([{ address: 'antwoord@vu.nl' }]);
    } finally { globalThis.fetch = original; }
  });
});
