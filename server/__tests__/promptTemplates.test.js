// Sjablonen voor cursusinstructies (server/promptTemplates.js, 2026-10-20):
// docenten lezen het sjabloon, alleen de beheerder wijzigt het, en de vorige
// tekst wordt bewaard. Echte Express-app met een kleine in-memory database.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { registerPromptTemplateRoutes, courseIdsWithOwnPrompt, validateTemplateContent } from '../prompts/promptTemplates.js';

const root = path.resolve(__dirname, '..', '..');

function fakeDb(state) {
  const from = (table) => {
    const f = { eq: {}, like: null };
    const rows = () => (state[table] || []).filter(r =>
      Object.entries(f.eq).every(([k, v]) => r[k] === v) &&
      (!f.like || String(r[f.like[0]]).startsWith(f.like[1].replace(/%$/, ''))));
    const b = {
      select: () => b,
      eq: (k, v) => { f.eq[k] = v; return b; },
      like: (k, v) => { f.like = [k, v]; return b; },
      update: (vals) => ({ eq: async (k, v) => { for (const r of state[table]) if (r[k] === v) Object.assign(r, vals); return { error: null }; } }),
      insert: async (row) => { (state[table] ||= []).push(row); return { error: null }; },
      then: (res) => res({ data: rows(), error: null }),
    };
    return b;
  };
  return { from };
}

let state;
let server;
async function call(method, url, role, body) {
  if (!server) throw new Error('no server');
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', 'x-role': role } }, (res) => {
      let raw = ''; res.on('data', c => (raw += c)); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

beforeEach(async () => {
  if (server) await new Promise(r => server.close(r));
  state = {
    chatbot_prompts: [
      { id: 't-chat', name: 'Sjabloon chat-instructie', section: 'chat', is_active: true, content: 'SJABLOON CHAT tekst' },
      { id: 'o-1', name: '__chat_prompt_c1__', section: 'internal', is_active: false, content: 'Eigen instructie c1' },
    ],
    courses: [{ id: 'c1', is_active: true }, { id: 'c2', is_active: true }, { id: 'c3', is_active: true }],
    leap_setting_changes: [],
  };
  const db = fakeDb(state);
  const app = express();
  app.use(express.json());
  const tpl = (id) => async () => { const r = state.chatbot_prompts.find(x => x.id === id); return { id: r?.id ?? null, content: r?.content ?? 'FALLBACK' }; };
  registerPromptTemplateRoutes(app, {
    supabaseAdmin: db,
    requireAuthUser: async (req, res) => {
      const role = req.headers['x-role'];
      if (role === 'anon') { res.status(401).json({ error: 'Niet geauthenticeerd' }); return null; }
      return { user: { id: `u-${role}` }, profile: { role: role === 'admin' ? 'admin' : 'student' } };
    },
    isAdminProfile: (p) => p?.role === 'admin',
    isStaffAnywhere: async (user) => user.id !== 'u-student',
    loadTemplate: { chat: tpl('t-chat'), explain: tpl('t-explain') },
  });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
});

describe('sjabloon lezen', () => {
  it('een docent ziet het sjabloon, maar mag het niet wijzigen', async () => {
    const r = await call('GET', '/api/admin/prompt-templates/chat', 'teacher');
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('SJABLOON CHAT tekst');
    expect(r.body.canEdit).toBe(false);
    expect(r.body.coursesOnTemplate).toBeUndefined();
  });
  it('een student krijgt het sjabloon niet via het beheer', async () => {
    expect((await call('GET', '/api/admin/prompt-templates/chat', 'student')).status).toBe(403);
  });
  it('de beheerder ziet op hoeveel cursussen het sjabloon nu werkt', async () => {
    const r = await call('GET', '/api/admin/prompt-templates/chat', 'admin');
    expect(r.body.canEdit).toBe(true);
    expect(r.body.coursesOnTemplate).toBe(2); // c1 heeft een eigen instructie
  });
  it('onbekend onderdeel (bijv. quiz) wordt geweigerd', async () => {
    expect((await call('GET', '/api/admin/prompt-templates/quiz', 'admin')).status).toBe(400);
  });
});

describe('sjabloon wijzigen', () => {
  it('een docent kan het sjabloon niet wijzigen', async () => {
    const r = await call('PUT', '/api/admin/prompt-templates/chat', 'teacher', { content: 'Nieuwe tekst die lang genoeg is' });
    expect(r.status).toBe(403);
    expect(state.chatbot_prompts[0].content).toBe('SJABLOON CHAT tekst');
  });
  it('de beheerder wijzigt het, en de vorige tekst wordt bewaard', async () => {
    const r = await call('PUT', '/api/admin/prompt-templates/chat', 'admin', { content: 'Nieuwe sjabloontekst voor iedereen' });
    expect(r.status).toBe(200);
    expect(state.chatbot_prompts[0].content).toBe('Nieuwe sjabloontekst voor iedereen');
    expect(state.leap_setting_changes).toHaveLength(1);
    expect(state.leap_setting_changes[0]).toMatchObject({ setting: 'prompt_template_chat', changed_by: 'u-admin', value: { previous: 'SJABLOON CHAT tekst' } });
  });
  it('een (bijna) leeg sjabloon wordt geweigerd', async () => {
    const r = await call('PUT', '/api/admin/prompt-templates/chat', 'admin', { content: '   kort ' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('templateTooShort');
  });
});

describe('hulpfuncties', () => {
  it('telt alleen niet-lege eigen instructies van het juiste onderdeel', () => {
    const own = courseIdsWithOwnPrompt([
      { name: '__chat_prompt_a__', content: 'x' },
      { name: '__chat_prompt_b__', content: '   ' },
      { name: '__explain_prompt_c__', content: 'x' },
    ], 'chat');
    expect([...own]).toEqual(['a']);
  });
  it('validateTemplateContent eist minstens 10 tekens', () => {
    expect(validateTemplateContent('0123456789').ok).toBe(true);
    expect(validateTemplateContent(42).ok).toBe(false);
  });
});

describe('het beheerscherm', () => {
  const panel = fs.readFileSync(path.join(root, 'src/components/CoursePromptsPanel.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'src/pages/AdminPage.tsx'), 'utf8');
  it('zet het sjabloon nooit in het eigen veld van de docent', () => {
    expect(panel).not.toMatch(/globalContent/);
    expect(admin).not.toMatch(/globalContent/);
  });
  it('schrijft sjablonen alleen via de server, niet rechtstreeks naar chatbot_prompts', () => {
    expect(panel).not.toMatch(/chatbot_prompts/);
    expect(panel).toMatch(/readOnly=\{!tplEditing\}/);
  });
});
