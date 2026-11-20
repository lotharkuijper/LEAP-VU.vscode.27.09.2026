// POST /api/admin/import-youtube: alleen een docent van déze cursus (of admin),
// en niets wordt ingelezen of opgeslagen bij een geweigerd of ongeldig verzoek.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ staff: true, auth: null, saved: [], embedded: 0 }));

vi.mock('../lib/auth.js', () => ({
  resolveAdminUser: async () => h.auth,
  isStaffForCourse: async () => h.staff,
}));
vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'c1', name: 'Embryologie' } }) }) }) }),
  },
}));
vi.mock('../lib/azureOpenai.js', () => ({
  AZURE_EMBEDDINGS_READY: true,
  EMBEDDINGS_NOT_CONFIGURED_MSG: 'geen embeddings',
  embedTextsServer: async (texts) => { h.embedded += texts.length; return texts.map(() => [0]); },
}));
vi.mock('../documents/courseFiles.js', () => ({
  WEB_SOURCE_PURPOSES: ['course_material', 'course_info'],
  recordDocMutation: async () => {},
}));
vi.mock('../ingestion/pipeline.js', () => ({ ensureCourseRagFolder: async () => ({ folderId: 'f1' }) }));
vi.mock('../ingestion/youtubeImport.js', async (orig) => ({
  ...(await orig()),
  fetchYouTubeTitle: async () => ({ title: 'Neurulatie', author: 'Maker' }),
  saveYouTubeDocument: async (_db, p) => { h.saved.push(p); return { documentId: 'd1', chunks: p.chunks.length, visualRefs: 0, updated: false }; },
}));

const { registerYouTubeRoutes } = await import('../ingestion/youtubeRoutes.js');

let handler;
registerYouTubeRoutes({ post: (_path, fn) => { handler = fn; } });

async function call(body) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body }, res);
  return res;
}

const transcript = Array.from({ length: 20 }, (_, i) => `0:${String(i * 2).padStart(2, '0')}\nDe neurale plaat vouwt zich tot een buis, stap ${i}.`).join('\n');
const ok = { courseId: 'c1', url: 'https://youtu.be/dQw4w9WgXcQ', transcript };

beforeEach(() => {
  h.staff = true;
  h.auth = { user: { id: 'u1' }, profile: { role: 'student' } };
  h.saved = [];
  h.embedded = 0;
});

describe('POST /api/admin/import-youtube', () => {
  it('voegt de video toe voor een docent van de cursus', async () => {
    const r = await call(ok);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, title: 'Neurulatie', documentId: 'd1' });
    expect(h.saved[0]).toMatchObject({ folderId: 'f1', videoId: 'dQw4w9WgXcQ', purpose: 'course_material', userId: 'u1' });
  });

  it('weigert wie geen docent van deze cursus is, zonder iets op te slaan', async () => {
    h.staff = false;
    const r = await call(ok);
    expect(r.statusCode).toBe(403);
    expect(h.saved).toEqual([]);
  });

  it('weigert zonder login', async () => {
    h.auth = { error: { status: 401, body: { error: 'Niet ingelogd' } } };
    expect((await call(ok)).statusCode).toBe(401);
    expect(h.saved).toEqual([]);
  });

  it('weigert een link die geen YouTube is, een leeg of te groot transcript en een ander doel', async () => {
    expect((await call({ ...ok, url: 'https://evil.example/watch?v=dQw4w9WgXcQ' })).body.code).toBe('badUrl');
    expect((await call({ ...ok, transcript: '0:00\nkort' })).body.code).toBe('noTranscript');
    expect((await call({ ...ok, transcript: 'x'.repeat(400_001) })).body.code).toBe('noTranscript');
    expect((await call({ ...ok, purpose: 'teacher_only' })).statusCode).toBe(400);
    const endless = Array.from({ length: 700 }, (_, i) => `${Math.floor((i * 3) / 60)}:${String((i * 3) % 60).padStart(2, '0')}:00\nwoord`).join('\n');
    expect((await call({ ...ok, transcript: endless })).body.code).toBe('tooLong');
    expect(h.saved).toEqual([]);
  });
});
