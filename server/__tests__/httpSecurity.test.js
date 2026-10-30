// Regression test for server/lib/httpSecurity.js: CORS only for the app's own
// origin, client IP taken from the one trusted proxy hop, safe headers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { applyHttpSecurity, allowedOrigins } from '../lib/httpSecurity.js';

let server; let base;
beforeAll(async () => {
  const app = express();
  applyHttpSecurity(app, { APP_PUBLIC_URL: 'https://leap.example.nl/', NODE_ENV: 'production' });
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('allowedOrigins', () => {
  it('uses the configured app URL without trailing slash; localhost only outside production', () => {
    expect(allowedOrigins({ APP_PUBLIC_URL: 'https://a.nl/', NODE_ENV: 'production' })).toEqual(['https://a.nl']);
    expect(allowedOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:5000');
  });
});

describe('applyHttpSecurity', () => {
  it('answers CORS only for the app origin', async () => {
    const own = await fetch(`${base}/ip`, { headers: { Origin: 'https://leap.example.nl' } });
    expect(own.headers.get('access-control-allow-origin')).toBe('https://leap.example.nl');
    const other = await fetch(`${base}/ip`, { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets safe headers and hides Express', async () => {
    const r = await fetch(`${base}/ip`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  it('takes the client IP from the last proxy hop, so a client cannot pick its own', async () => {
    const r = await fetch(`${base}/ip`, { headers: { 'X-Forwarded-For': '6.6.6.6, 1.2.3.4' } });
    expect((await r.json()).ip).toBe('1.2.3.4');
  });
});
