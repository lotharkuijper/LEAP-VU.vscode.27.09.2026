import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

// ───────────────────────────────────────────────────────────────────────────
// Persona's strikt per cursus (2026-09-27). Toetst dat de persona-sjablonen
// (course_personas) en het kopiëren tussen project en sjablonen alleen werken
// voor staf van DIE cursus:
//   • docent van cursus A beheert de sjablonen van A (niet langer admin-only);
//   • docent van cursus B kan sjablonen van A niet aanmaken, wijzigen of
//     verwijderen (404/403), en student kan niets;
//   • "kopieer naar bibliotheek" werkt voor de docent van de projectcursus en
//     komt in de bibliotheek van diezelfde cursus;
//   • een sjabloon van een andere cursus kan niet in een project komen.
// Zelfde in-memory Supabase-stub als importWebEndpoints.test.js.
// ───────────────────────────────────────────────────────────────────────────

// Gedeelde, hoistbare harness — vi.mock-factories mogen alleen naar hier gehoiste
// waarden verwijzen. Bevat de in-memory DB + de huidige geauthenticeerde user.
const harness = vi.hoisted(() => {
  const state = {
    user: null, // wordt per test gezet; null ⇒ caller.auth.getUser() faalt
    db: { tables: {}, counter: 1 },
  };

  function resetDb(tables = {}) {
    state.db = { tables: {}, counter: 1 };
    for (const [name, rows] of Object.entries(tables)) {
      state.db.tables[name] = rows.map((r) => ({ ...r }));
    }
  }

  // Minimalistische PostgREST-achtige query-builder over in-memory arrays.
  class QueryBuilder {
    constructor(db, table) {
      this.db = db;
      this.table = table;
      this.filters = [];
      this._limit = null;
      this._op = 'select';
      this._payload = null;
      this._returnRows = null;
    }
    select() { return this; }
    order() { return this; }
    eq(col, val) { this.filters.push({ type: 'eq', col, val }); return this; }
    in(col, vals) { this.filters.push({ type: 'in', col, vals }); return this; }
    limit(n) { this._limit = n; return this; }

    _rows() {
      return (this.db.tables[this.table] = this.db.tables[this.table] || []);
    }
    _match() {
      let rows = this._rows();
      for (const f of this.filters) {
        if (f.type === 'eq') rows = rows.filter((r) => r[f.col] === f.val);
        else if (f.type === 'in') rows = rows.filter((r) => f.vals.includes(r[f.col]));
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return rows;
    }
    insert(payload) {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((row) => {
        const r = { id: row.id ?? `id-${this.db.counter++}`, ...row };
        this._rows().push(r);
        return r;
      });
      this._op = 'insert';
      this._returnRows = inserted;
      return this;
    }
    update(payload) { this._op = 'update'; this._payload = payload; return this; }
    delete() { this._op = 'delete'; return this; }

    maybeSingle() { return this._single(false); }
    single() { return this._single(true); }
    async _single(strict) {
      const { data, error } = await this._run();
      if (error) return { data: null, error };
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      if (arr.length === 0) {
        return strict ? { data: null, error: { message: 'No rows found' } } : { data: null, error: null };
      }
      return { data: arr[0], error: null };
    }
    then(resolve, reject) { return this._run().then(resolve, reject); }
    async _run() {
      try {
        if (this._op === 'insert') return { data: this._returnRows, error: null };
        if (this._op === 'update') {
          const rows = this._match();
          for (const r of rows) Object.assign(r, this._payload);
          return { data: rows, error: null };
        }
        if (this._op === 'delete') {
          const rows = new Set(this._match());
          this.db.tables[this.table] = this._rows().filter((r) => !rows.has(r));
          return { data: [...rows], error: null };
        }
        return { data: this._match(), error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    }
  }

  function createClientImpl(url, key, opts) {
    // Caller-client (auth): herkenbaar aan de doorgegeven Authorization-header.
    if (opts?.global?.headers?.Authorization) {
      return {
        auth: {
          getUser: async () => state.user
            ? { data: { user: state.user }, error: null }
            : { data: { user: null }, error: { message: 'Invalid token' } },
        },
      };
    }
    // Admin-client (service role): in-memory query-builder.
    return {
      from: (table) => new QueryBuilder(state.db, table),
      rpc: async () => ({ data: [], error: null }),
      auth: { getUser: async () => ({ data: { user: null }, error: { message: 'n/a' } }) },
    };
  }

  return { state, resetDb, createClientImpl };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: harness.createClientImpl,
}));

// SSRF-DNS-guard: laat publieke hostnamen naar een publiek IP resolven zodat de
// happy-path niet afhangt van echte (en in de sandbox onbetrouwbare) DNS.
vi.mock('node:dns', () => ({
  promises: {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  },
}));

let app;
let server;
const savedEnv = {};
const ENV_KEYS = [
  'NODE_ENV', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  'VITE_PUBLIC_SUPABASE_URL', 'VITE_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL',
  'WEB_IMPORT_HEARTBEAT_MS', 'WEB_IMPORT_PAGE_PACING_MS',
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
  process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
  process.env.VITE_PUBLIC_SUPABASE_URL = 'http://stub.supabase.local';
  process.env.VITE_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.SUPABASE_DB_URL; // geen pg-pool nodig
  // Task #391: heartbeat-interval = de (geklemde) minimum van 1000ms; pacing uit
  // zodat de tests niet onnodig wachten tussen pagina's.
  process.env.WEB_IMPORT_HEARTBEAT_MS = '1000';
  process.env.WEB_IMPORT_PAGE_PACING_MS = '0';

  const mod = await import('../index.js');
  app = mod.app;
  // De content_hash-startupdetectie draait niet onder NODE_ENV=test; zet de vlag
  // hier expliciet aan zodat de top-up/skip-paden getest worden (de in-memory
  // stub kent de kolom en geeft geen fout terug).
  await mod.detectDocumentsContentHash();
  // Idem voor websitebronnen: de stub kent de tabel web_sources.
  await mod.detectWebSources();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
  harness.state.user = null;
  harness.resetDb();
});


const ADMIN = { id: 'user-admin', role: 'admin', email: 'admin@vu.nl' };
const TEACHER_A = { id: 'user-teacher-a', role: 'student', email: 'a@vu.nl' };
const TEACHER_B = { id: 'user-teacher-b', role: 'docent', email: 'b@vu.nl' };
const STUDENT = { id: 'user-student', role: 'student', email: 's@vu.nl' };
const COURSE_A = 'course-a';
const COURSE_B = 'course-b';

function seed(user) {
  harness.state.user = { id: user.id, email: user.email };
  harness.resetDb({
    profiles: [ADMIN, TEACHER_A, TEACHER_B, STUDENT].map((u) => ({ id: u.id, role: u.role, email: u.email })),
    course_members: [
      { user_id: TEACHER_A.id, course_id: COURSE_A, member_role: 'teacher' },
      { user_id: TEACHER_B.id, course_id: COURSE_B, member_role: 'teacher' },
      { user_id: STUDENT.id, course_id: COURSE_A, member_role: 'student' },
    ],
    courses: [{ id: COURSE_A, name: 'Cursus A' }, { id: COURSE_B, name: 'Cursus B' }],
    projects: [
      { id: 'proj-a', course_id: COURSE_A, title: 'Project A' },
      { id: 'proj-b', course_id: COURSE_B, title: 'Project B' },
    ],
    course_personas: [
      { id: 'tpl-a', course_id: COURSE_A, name: 'Wethouder', system_prompt: 'geheim A', persona_type: 'conversational' },
      { id: 'tpl-b', course_id: COURSE_B, name: 'Beoordelaar B', system_prompt: 'geheim B', persona_type: 'evaluator' },
    ],
    project_personas: [
      { id: 'pp-a', project_id: 'proj-a', name: 'Buurtbewoner', system_prompt: 'x', persona_type: 'conversational', sort_order: 0 },
    ],
  });
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const { port } = server.address();
    const headers = { Authorization: 'Bearer test-token' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const templates = () => harness.state.db.tables.course_personas;

describe('persona-sjablonen: beheer per cursus', () => {
  it('docent van de cursus maakt een sjabloon aan (niet langer alleen admins)', async () => {
    seed(TEACHER_A);
    const res = await request('POST', '/api/admin/course-personas', { course_id: COURSE_A, name: 'Journalist' });
    expect(res.status).toBe(201);
    expect(templates().find((p) => p.name === 'Journalist')).toMatchObject({ course_id: COURSE_A, created_by: TEACHER_A.id });
  });

  it('docent van een andere cursus kan geen sjabloon in deze cursus aanmaken (403)', async () => {
    seed(TEACHER_B);
    const res = await request('POST', '/api/admin/course-personas', { course_id: COURSE_A, name: 'Indringer' });
    expect(res.status).toBe(403);
    expect(templates().some((p) => p.name === 'Indringer')).toBe(false);
  });

  it('student kan geen sjabloon aanmaken (403)', async () => {
    seed(STUDENT);
    const res = await request('POST', '/api/admin/course-personas', { course_id: COURSE_A, name: 'X' });
    expect(res.status).toBe(403);
  });

  it('docent van cursus B kan een sjabloon van cursus A niet wijzigen of verwijderen', async () => {
    seed(TEACHER_B);
    const patch = await request('PATCH', '/api/admin/course-personas/tpl-a', { system_prompt: 'overschreven' });
    expect(patch.status).toBe(404);
    const del = await request('DELETE', '/api/admin/course-personas/tpl-a');
    expect(del.status).toBe(404);
    expect(templates().find((p) => p.id === 'tpl-a')).toMatchObject({ system_prompt: 'geheim A' });
  });

  it('docent van cursus A wijzigt en verwijdert de eigen sjablonen', async () => {
    seed(TEACHER_A);
    const patch = await request('PATCH', '/api/admin/course-personas/tpl-a', { name: 'Wethouder Zorg' });
    expect(patch.status).toBe(200);
    expect(templates().find((p) => p.id === 'tpl-a').name).toBe('Wethouder Zorg');
    const del = await request('DELETE', '/api/admin/course-personas/tpl-a');
    expect(del.status).toBe(200);
    expect(templates().some((p) => p.id === 'tpl-a')).toBe(false);
  });

  it('admin beheert sjablonen in elke cursus', async () => {
    seed(ADMIN);
    const res = await request('PATCH', '/api/admin/course-personas/tpl-b', { name: 'Beoordelaar' });
    expect(res.status).toBe(200);
  });
});

describe('persona\'s tussen project en sjablonen', () => {
  it('docent van de projectcursus bewaart een project-persona als sjabloon in diezelfde cursus', async () => {
    seed(TEACHER_A);
    const res = await request('POST', '/api/projects/proj-a/personas/pp-a/copy-to-library');
    expect(res.status).toBe(200);
    expect(templates().find((p) => p.name === 'Buurtbewoner')).toMatchObject({ course_id: COURSE_A });
  });

  it('docent van een andere cursus kan een project-persona niet als sjabloon bewaren (403)', async () => {
    seed(TEACHER_B);
    const res = await request('POST', '/api/projects/proj-a/personas/pp-a/copy-to-library');
    expect(res.status).toBe(403);
    expect(templates().some((p) => p.name === 'Buurtbewoner')).toBe(false);
  });

  it('een sjabloon van een andere cursus komt niet in een project (400)', async () => {
    seed(ADMIN);
    const res = await request('POST', '/api/projects/proj-a/personas/from-library/tpl-b');
    expect(res.status).toBe(400);
    expect(harness.state.db.tables.project_personas.some((p) => p.name === 'Beoordelaar B')).toBe(false);
  });
});

describe('herkomst van kopieën (voor "gebruikt in" bij sjablonen)', () => {
  it('een kopie uit een sjabloon onthoudt van welk sjabloon ze komt, en blijft een losse kopie', async () => {
    seed(TEACHER_A);
    const first = await request('POST', '/api/projects/proj-a/personas/from-library/tpl-a');
    const second = await request('POST', '/api/projects/proj-a/personas/from-library/tpl-a');
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    const copies = harness.state.db.tables.project_personas.filter((p) => p.name === 'Wethouder');
    // Twee losse kopieën toegestaan (geen deduplicatie), beide met herkomst.
    expect(copies).toHaveLength(2);
    expect(copies.every((p) => p.source_persona_id === 'tpl-a')).toBe(true);
  });
});
