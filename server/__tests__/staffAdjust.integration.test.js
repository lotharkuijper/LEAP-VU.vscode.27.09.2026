// Integratietest voor de correctie door de docent op de verstandhouding van een
// rolspeler. De route draait op een echte Express-app met echte HTTP-verzoeken;
// Supabase is een in-memory testdouble en het niveau wordt gezet met de echte
// setRelationshipLevelImpl, zodat score + geschiedenis end-to-end gedekt zijn.
//
// Regels:
//   - de docent kiest een niveau (-3 = contact verbroken … +2 warm) met een motivatie;
//   - daarmee kan de docent ook een verbroken contact herstellen;
//   - alleen bij een rolspeler die een verstandhouding bijhoudt;
//   - niet-docenten krijgen 403, een lege motivatie 400.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { registerRelationshipAdjustRoute } from '../relationshipAdjust.js';
import { setRelationshipLevelImpl } from '../threadClose.js';
import { levelKey } from '../personaRelationship.js';
import { reputationActive } from '../personaRoles.js';
import { makeFakeRelationshipSupabase } from './helpers/fakeRelationshipSupabase.js';

const PROJECT_ID = 'proj-1';
const GROUP_ID = 'group-1';
const PERSONA_ID = 'persona-1';
const STAFF_ID = 'user-staff';

let authState;
let staffState;
const state = { relationships: [] };
const fakeSupabase = makeFakeRelationshipSupabase(state);

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRelationshipAdjustRoute(app, {
    supabaseAdmin: fakeSupabase,
    authUser: async () => (authState
      ? { user: authState.user }
      : { error: { status: 401, body: { error: 'Niet geauthenticeerd' } } }),
    isStaffForCourse: async () => staffState,
    setRelationshipLevel: (args) => setRelationshipLevelImpl({ supabaseAdmin: fakeSupabase }, args),
    levelKey,
    reputationActive,
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  authState = { user: { id: STAFF_ID, email: 'docent@vu.nl' } };
  staffState = true;
  state.project = { id: PROJECT_ID, course_id: 'course-1' };
  state.group = { id: GROUP_ID, project_id: PROJECT_ID };
  state.persona = { id: PERSONA_ID, project_id: PROJECT_ID, persona_type: 'roleplayer', reputation_enabled: true, start_level: 0 };
  state.profile = { role: 'teacher', email: 'docent@vu.nl' };
  state.relationships = [];
});

function adjust(body) {
  return fetch(`${baseUrl}/api/projects/${PROJECT_ID}/groups/${GROUP_ID}/personas/${PERSONA_ID}/relationship-adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
}

describe('correctie door de docent', () => {
  it('zet het gekozen niveau en schrijft een staff_adjust-gebeurtenis', async () => {
    const res = await adjust({ level: 1, note: 'Goede voortgang besproken' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.relationship.level).toBe(1);
    expect(json.relationship.key).toBe('positive');
    const evt = json.relationship.history.at(-1);
    expect(evt).toMatchObject({ source: 'staff_adjust', by: STAFF_ID, note: 'Goede voortgang besproken', from: 0, to: 1 });
    expect(evt.refId).toMatch(new RegExp(`^staff_adjust:${STAFF_ID}:\\d+$`));
    expect(state.relationships[0].score).toBe(1);
  });

  it('kan een verbroken contact herstellen', async () => {
    state.relationships.push({ id: 'rel-x', project_id: PROJECT_ID, group_id: GROUP_ID, persona_id: PERSONA_ID, score: -3, history: [] });
    const res = await adjust({ level: -1, note: 'Excuses aangeboden in de werkgroep' });
    expect(res.status).toBe(200);
    expect((await res.json()).relationship.key).toBe('strained');
    expect(state.relationships[0].score).toBe(-1);
  });

  it('zonder bestaande rij geldt het startniveau van de persona als "van"', async () => {
    state.persona.start_level = -1;
    const res = await adjust({ level: 2, note: 'Uitstekend verlopen' });
    expect((await res.json()).relationship.history.at(-1)).toMatchObject({ from: -1, to: 2 });
  });

  it('weigert een persona zonder verstandhouding (begeleider of uitgezet)', async () => {
    state.persona = { ...state.persona, persona_type: 'conversational' };
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(400);
    state.persona = { ...state.persona, persona_type: 'roleplayer', reputation_enabled: false };
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(400);
    expect(state.relationships).toHaveLength(0);
  });

  it('weigert een niet-docent met 403', async () => {
    staffState = false;
    const res = await adjust({ level: 1, note: 'Mag niet' });
    expect(res.status).toBe(403);
    expect(state.relationships).toHaveLength(0);
  });

  it('weigert een lege of ontbrekende motivatie met 400', async () => {
    expect((await adjust({ level: 1, note: '   ' })).status).toBe(400);
    expect((await adjust({ level: 1 })).status).toBe(400);
  });

  it('weigert een niveau buiten -3..+2 met 400', async () => {
    expect((await adjust({ level: 3, note: 'Te hoog' })).status).toBe(400);
    expect((await adjust({ level: -4, note: 'Te laag' })).status).toBe(400);
    expect((await adjust({ note: 'Geen niveau' })).status).toBe(400);
  });

  it('401 zonder login; 404 bij een vreemd project, groep of persona', async () => {
    authState = null;
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(401);
    authState = { user: { id: STAFF_ID } };
    state.project = null;
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(404);
    state.project = { id: PROJECT_ID, course_id: 'course-1' };
    state.group = { id: GROUP_ID, project_id: 'ander' };
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(404);
    state.group = { id: GROUP_ID, project_id: PROJECT_ID };
    state.persona = { ...state.persona, project_id: 'ander' };
    expect((await adjust({ level: 1, note: 'x' })).status).toBe(404);
  });
});
