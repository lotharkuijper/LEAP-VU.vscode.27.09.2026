import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmailConfig, getGraphToken, sendEmailViaGraph, resetGraphTokenForTests } from '../notifications.js';

const azureEnv = {
  MAIL_UAMI_CLIENT_ID: 'client-id-123',
  MAIL_SENDER: 'afzender@vu.nl',
  IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
  IDENTITY_HEADER: 'header-geheim',
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => resetGraphTokenForTests());

describe('getEmailConfig', () => {
  it('kiest Graph zodra de identiteit en de afzender zijn ingesteld', async () => {
    expect(await getEmailConfig(azureEnv)).toEqual({ provider: 'graph', from: 'afzender@vu.nl' });
  });
  it('kiest Graph niet buiten Azure (geen identiteits-eindpunt), ook al staat de afzender er', async () => {
    const cfg = await getEmailConfig({ MAIL_UAMI_CLIENT_ID: 'x', MAIL_SENDER: 'a@vu.nl', RESEND_API_KEY: 're_1' });
    expect(cfg).toEqual({ provider: 'resend', apiKey: 're_1', from: 'Studiecafé <onboarding@resend.dev>' });
  });
  it('geeft null zonder enige configuratie, zodat de wachtrij blijft staan', async () => {
    expect(await getEmailConfig({})).toBeNull();
  });
});

describe('sendEmailViaGraph', () => {
  it('haalt een token op met de client-id en verstuurt als de afzender', async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).startsWith(azureEnv.IDENTITY_ENDPOINT)
        ? json(200, { access_token: 'tok', expires_on: String(Math.floor(Date.now() / 1000) + 3600) })
        : { ok: true, status: 202, text: async () => '' });
    const result = await sendEmailViaGraph(
      { from: 'afzender@vu.nl', to: 'student@student.vu.nl', subject: 'Onderwerp', html: '<p>Hoi</p>', text: 'Hoi' },
      { env: azureEnv, fetchImpl },
    );
    expect(result).toEqual({ ok: true, status: 202 });

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toContain('client_id=client-id-123');
    expect(tokenUrl).toContain('resource=https%3A%2F%2Fgraph.microsoft.com');
    expect(tokenInit.headers['X-IDENTITY-HEADER']).toBe('header-geheim');

    const [mailUrl, mailInit] = fetchImpl.mock.calls[1];
    expect(mailUrl).toBe('https://graph.microsoft.com/v1.0/users/afzender%40vu.nl/sendMail');
    expect(mailInit.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(mailInit.body);
    expect(body.saveToSentItems).toBe(false);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'student@student.vu.nl' } }]);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>Hoi</p>' });
  });

  it('hergebruikt het token tot het bijna verloopt', async () => {
    const fetchImpl = vi.fn(async () => json(200, { access_token: 'tok', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
    await getGraphToken({ env: azureEnv, fetchImpl });
    await getGraphToken({ env: azureEnv, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getGraphToken({ env: azureEnv, fetchImpl, now: Date.now() + 58 * 60 * 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('geeft een fout terug in plaats van te gooien (wachtrij blijft staan)', async () => {
    const denied = vi.fn(async (url) =>
      String(url).startsWith(azureEnv.IDENTITY_ENDPOINT)
        ? json(200, { access_token: 'tok', expires_on: '0' })
        : json(403, { error: { code: 'ErrorAccessDenied' } }));
    const r1 = await sendEmailViaGraph({ from: 'a@vu.nl', to: 'b@vu.nl', subject: 's', text: 't' }, { env: azureEnv, fetchImpl: denied });
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(403);
    expect(r1.error).toContain('ErrorAccessDenied');

    resetGraphTokenForTests();
    const noToken = vi.fn(async () => json(400, {}));
    const r2 = await sendEmailViaGraph({ from: 'a@vu.nl', to: 'b@vu.nl', subject: 's', text: 't' }, { env: azureEnv, fetchImpl: noToken });
    expect(r2).toEqual({ ok: false, status: 0, error: 'Graph-token ophalen mislukt (HTTP 400)' });
  });
});
