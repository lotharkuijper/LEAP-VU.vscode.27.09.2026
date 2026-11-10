// Eindproduct één keer inleveren (besluit 2026-11-11): een tweede inlevering van
// dezelfde groep wordt geweigerd; alleen in een concept (docent probeert uit)
// vervangt een nieuwe upload de vorige. Gedragstest met een nep-database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { project: null, submissions: [], queries: [] };

vi.mock('../lib/supabase.js', () => ({
  SUPERUSER_EMAIL: 'super@vu.nl',
  supabaseAdmin: {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() {
          if (table === 'projects') return { data: db.project };
          if (table === 'project_groups') return { data: { id: 'g1', project_id: 'p1', status: 'active' } };
          return { data: null };
        },
      };
      return chain;
    },
  },
  pgPool: {
    async connect() {
      return {
        async query(sql, params = []) {
          db.queries.push(sql);
          if (/^SELECT 1 FROM project_submissions/.test(sql)) return { rowCount: db.submissions.length, rows: [] };
          if (/^\s*INSERT INTO project_submissions/.test(sql)) {
            db.submissions.push({ id: 'new', filename: params[3] });
            return { rows: [{ id: 'new', filename: params[3] }] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {},
      };
    },
  },
}));
vi.mock('../lib/auth.js', async (orig) => ({ ...(await orig()), authUser: async () => ({ user: { id: 'u1' } }) }));
vi.mock('../projects/access.js', async (orig) => ({ ...(await orig()), isGroupMember: async () => true }));
vi.mock('../projects/preassessment.js', () => ({
  createPreassessmentRunner: () => ({ start: () => {} }),
  registerPreassessmentRoutes: () => {},
}));
vi.mock('../lib/uploads.js', () => ({
  docUpload: { single: () => (_req, _res, next) => next?.() },
  extractTextFromUpload: async () => '',
}));

const { registerProjectDocumentRoutes } = await import('../projects/documentRoutes.js');
const routes = {};
const app = new Proxy({}, { get: (_t, method) => (path, ...handlers) => { routes[`${String(method).toUpperCase()} ${path}`] = handlers.at(-1); } });
registerProjectDocumentRoutes(app);
const upload = routes['POST /api/projects/:projectId/submissions'];

async function submit() {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await upload({
    params: { projectId: 'p1' },
    body: { groupId: 'g1' },
    file: { originalname: 'eindrapport.pdf', size: 10, mimetype: 'application/pdf', buffer: Buffer.from('x') },
    headers: {},
  }, res);
  return res;
}

beforeEach(() => {
  db.project = { id: 'p1', submissions_enabled: true, status: 'active', preassessment_persona_id: null };
  db.submissions = [];
  db.queries = [];
});

describe('eindproduct inleveren', () => {
  it('de eerste inlevering lukt', async () => {
    const res = await submit();
    expect(res.statusCode).toBe(200);
    expect(res.body.submission.filename).toBe('eindrapport.pdf');
  });

  it('een tweede inlevering van dezelfde groep wordt geweigerd', async () => {
    await submit();
    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('alreadySubmitted');
    expect(db.submissions).toHaveLength(1);
  });

  it('de groep gaat op slot voordat er gecontroleerd wordt', async () => {
    await submit();
    const lock = db.queries.findIndex(q => /FOR UPDATE/.test(q));
    const check = db.queries.findIndex(q => /^SELECT 1 FROM project_submissions/.test(q));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(check);
  });

  it('in een concept vervangt de docent zijn testinlevering', async () => {
    db.project.status = 'draft';
    await submit();
    const res = await submit();
    expect(res.statusCode).toBe(200);
  });
});
