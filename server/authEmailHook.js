// ───────────────────────────────────────────────────────────────────────────
// Account-e-mails (bevestigen, uitnodiging, wachtwoord vergeten) bij hosting
// op Azure.
//
// Bij Supabase in de cloud verstuurt Supabase deze e-mails zelf. Op Azure
// draait de inlogdienst (Supabase Auth) in eigen beheer en heeft die geen
// mailserver. De dienst roept daarom deze server aan ("send email hook"), en
// die verstuurt de e-mail via dezelfde route als de Studiecafé-meldingen
// (server/notifications.js). De inlogstroom zelf blijft gelijk.
//
// De aanroep is ondertekend volgens Standard Webhooks (HMAC-SHA256 met het
// gedeelde geheim AUTH_EMAIL_HOOK_SECRET); zonder geldige handtekening wordt
// er niets verstuurd. Zonder dat geheim bestaat de route niet.
// ───────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { translate } from './notificationI18n.js';
import { escapeHtml } from './notifications.js';

const TOLERANCE_SEC = 5 * 60;

// Het geheim staat als "v1,whsec_<base64>"; meerdere geheimen (bij het
// wisselen van sleutel) zijn gescheiden door "|".
function secretKeys(secret) {
  return String(secret || '')
    .split('|')
    .map((s) => s.trim().replace(/^v1,/, '').replace(/^whsec_/, ''))
    .filter(Boolean)
    .map((b64) => Buffer.from(b64, 'base64'));
}

// Controleert de handtekening van de aanroep. `rawBody` is de ONBEWERKTE
// tekst van het verzoek; een opnieuw geserialiseerde body klopt niet.
export function verifyHookSignature({ secret, headers, rawBody, nowMs = Date.now() }) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = String(headers['webhook-signature'] || '');
  const keys = secretKeys(secret);
  if (!id || !timestamp || !signatures || !keys.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SEC) return false;

  const given = signatures
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s.slice(3), 'base64'));
  const signed = `${id}.${timestamp}.${rawBody}`;
  for (const key of keys) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest();
    for (const sig of given) {
      if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) return true;
    }
  }
  return false;
}

// Soort e-mail → groep vertaalsleutels (email.auth.<groep>.*). Onbekende
// soorten (bv. e-mailadres wijzigen) krijgen de algemene tekst.
const TEXT_GROUP = { signup: 'signup', invite: 'invite', recovery: 'recovery' };

// Link waarmee de ontvanger de actie afrondt. De inlogdienst controleert de
// code en stuurt daarna door naar de app (redirect_to).
export function buildVerifyLink({ supabaseUrl, emailData, appUrl = '' }) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const redirect = emailData.redirect_to || emailData.site_url || appUrl;
  const q = new URLSearchParams({ token: emailData.token_hash, type: emailData.email_action_type });
  if (redirect) q.set('redirect_to', redirect);
  return `${base}/auth/v1/verify?${q.toString()}`;
}

// Bouwt { subject, html, text } voor één account-e-mail.
export function buildAuthEmail(emailData, { lang = 'nl', supabaseUrl, appUrl = '', userName = '' } = {}) {
  const group = TEXT_GROUP[emailData.email_action_type] || 'generic';
  const t = (key, vars) => translate(lang, key, vars);
  const link = buildVerifyLink({ supabaseUrl, emailData, appUrl });
  const greeting = userName ? t('email.digest.greeting', { name: userName }) : t('email.digest.greetingNoName');
  const subject = t(`email.auth.${group}.subject`);
  const intro = t(`email.auth.${group}.intro`);
  const cta = t(`email.auth.${group}.cta`);
  const linkHint = t('email.auth.linkHint');
  const ignore = t('email.auth.ignore');

  const text = [greeting, '', intro, '', `${cta}: ${link}`, '', ignore].join('\n');
  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">` +
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>${escapeHtml(intro)}</p>` +
    `<p style="margin:20px 0"><a href="${escapeHtml(link)}" ` +
    `style="background:#f59e0b;color:#fff;padding:10px 18px;border-radius:10px;` +
    `text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta)}</a></p>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(linkHint)}<br/>` +
    `<a href="${escapeHtml(link)}" style="color:#888;word-break:break-all">${escapeHtml(link)}</a></p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(ignore)}</p>` +
    `</div>`;
  return { subject, html, text };
}

// Antwoord in de vorm die de inlogdienst verwacht bij een fout.
function hookError(res, status, message) {
  return res.status(status).json({ error: { http_code: status, message } });
}

// Registreert POST /api/auth/email-hook. Moet vóór express.json() staan: de
// handtekening gaat over de onbewerkte body. `deps`:
//   secret        het gedeelde geheim (leeg = route niet registreren)
//   supabaseUrl   publiek adres van de inlogdienst
//   appUrl()      publiek adres van de app (terugval voor redirect_to)
//   getLang(id)   voorkeurstaal van de gebruiker (mag null geven)
//   getEmailConfig(), sendEmail(cfg, msg)   uit notifications.js
export function registerAuthEmailHook(app, express, deps) {
  if (!deps.secret) return false;
  app.post('/api/auth/email-hook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyHookSignature({ secret: deps.secret, headers: req.headers, rawBody })) {
      return hookError(res, 401, 'Ongeldige handtekening');
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return hookError(res, 400, 'Ongeldige body');
    }
    const user = payload && payload.user;
    const emailData = payload && payload.email_data;
    if (!user || !user.email || !emailData || !emailData.token_hash || !emailData.email_action_type) {
      return hookError(res, 400, 'Onvolledige aanroep');
    }
    try {
      const cfg = await deps.getEmailConfig();
      if (!cfg) return hookError(res, 503, 'E-mail is niet geconfigureerd');
      const lang = (await deps.getLang(user.id).catch(() => null)) || 'nl';
      const fullName = (user.user_metadata && user.user_metadata.full_name) || '';
      const mail = buildAuthEmail(emailData, {
        lang,
        supabaseUrl: deps.supabaseUrl,
        appUrl: deps.appUrl(),
        userName: String(fullName).split(' ')[0] || '',
      });
      const result = await deps.sendEmail(cfg, { to: user.email, ...mail });
      if (!result.ok) {
        console.warn(`[auth-email] verzenden mislukt (${emailData.email_action_type}): ${result.error}`);
        // 429 doorgeven: de inlogdienst meldt dan "te veel e-mails" aan de gebruiker.
        return hookError(res, result.status === 429 ? 429 : 502, 'E-mail versturen mislukt');
      }
      return res.status(200).json({});
    } catch (e) {
      console.warn('[auth-email] onverwachte fout:', e.message);
      return hookError(res, 500, 'E-mail versturen mislukt');
    }
  });
  return true;
}
