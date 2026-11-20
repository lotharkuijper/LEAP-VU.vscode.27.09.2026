// Beeldoefeningen, speelbord (database-kant): starten, nakijken, hint, afronden.
// Belangrijkste eis: de student krijgt nooit de beschrijving of de labels van
// kenmerken die nog niet gevonden zijn, tot hij of zij afrondt.
import { describe, it, expect, beforeEach } from 'vitest';
import { listForStudent, startAttempt, answer, hint, finish, restartAttempt } from '../imageExercises/playService.js';

let tables;
let seq = 0;

function fakeDb() {
  return {
    from(table) {
      const f = { eq: [], in: [] };
      let op = 'select';
      let payload = null;
      let lim = null;
      let ord = null;
      const rows = () => (tables[table] ||= []);
      const match = (r) => f.eq.every(([k, v]) => r[k] === v) && f.in.every(([k, v]) => v.includes(r[k]));
      const run = () => {
        if (op === 'insert') {
          const row = { id: `att${++seq}`, status: 'active', progress: {}, hints: {}, turns: [], answers: 0, created_at: `2026-11-21T00:00:0${seq}`, ...payload };
          rows().push(row);
          return { data: { ...row }, error: null };
        }
        if (op === 'update') { rows().filter(match).forEach((r) => Object.assign(r, payload)); return { error: null }; }
        let hit = rows().filter(match).map((r) => ({ ...r }));
        if (ord) hit.sort((x, y) => (ord.asc ? 1 : -1) * String(x[ord.col]).localeCompare(String(y[ord.col])));
        if (lim != null) hit = hit.slice(0, lim);
        return { data: hit, error: null };
      };
      const chain = {
        select() { return chain; },
        eq(k, v) { f.eq.push([k, v]); return chain; },
        in(k, v) { f.in.push([k, v]); return chain; },
        order(col, o) { if (!ord) ord = { col, asc: o?.ascending !== false }; return chain; },
        limit(n) { lim = n; return chain; },
        insert(p) { op = 'insert'; payload = p; return chain; },
        update(p) { op = 'update'; payload = p; return chain; },
        async single() { return run(); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return chain;
    },
    storage: { from: () => ({ async createSignedUrls(paths) { return { data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })) }; } }) },
  };
}

const db = () => fakeDb();
const C = 'course1';
const base = { courseId: C, userId: 'stud1', id: 'ex1' };

beforeEach(() => {
  seq = 0;
  tables = {
    image_exercises: [
      { id: 'ex1', course_id: C, storage_path: 'c/ex1.jpg', position: 0, depth: 'describe', count_display: 'exact', description: 'GEHEIME BESCHRIJVING', description_confirmed_at: 'x', features_status: 'ready', created_at: '1' },
      { id: 'ex2', course_id: C, storage_path: 'c/ex2.jpg', position: 1, depth: 'describe', count_display: 'none', description: 'Nog niet bevestigd', description_confirmed_at: null, features_status: 'ready', created_at: '2' },
    ],
    image_exercise_features: [
      { id: 'f1', exercise_id: 'ex1', position: 0, label: 'Humuslaag', observation: 'gelige laag onderin', interpretation: '', is_core: true, open_interpretation: false },
      { id: 'f2', exercise_id: 'ex1', position: 1, label: 'Schimmeldraden', observation: 'witte draden', interpretation: 'afbraak', is_core: false, open_interpretation: false },
    ],
    image_exercise_attempts: [],
  };
});

const leaksKey = (obj) => /GEHEIME|Schimmeldraden|witte draden/.test(JSON.stringify(obj));

describe('speelbord voor de student', () => {
  it('toont alleen bevestigde foto’s met kenmerken, zonder bestandsnaam of beschrijving', async () => {
    const list = await listForStudent(db(), { courseId: C, userId: 'stud1' });
    expect(list).toEqual([{ id: 'ex1', number: 1, imageUrl: 'https://signed/c/ex1.jpg', status: 'new', coreDone: false, found: 0 }]);
  });

  it('een foto die niet klaar is, is niet te openen', async () => {
    await expect(startAttempt(db(), { ...base, id: 'ex2' })).rejects.toMatchObject({ status: 404 });
  });

  it('starten geeft een leeg bord zonder sleutel', async () => {
    const s = await startAttempt(db(), base);
    expect(s.board).toMatchObject({ tiles: [], count: { mode: 'exact', core: 1, extra: 1 } });
    expect(s.description).toBeUndefined();
    expect(leaksKey(s)).toBe(false);
  });

  it('nakijken: een gevonden kenmerk verschijnt; de rest blijft verborgen', async () => {
    const llm = async () => ({ results: [{ key: 'k1', state: 'full', quote: 'dikke gelige humuslaag' }], outside: false, feedback: 'Goed gezien, die gelige laag!' });
    const s = await answer(db(), llm, { ...base, text: 'Onderin een dikke gelige humuslaag.' });
    expect(s.board.tiles).toEqual([{ id: 'f1', core: true, state: 'full', how: 'self', label: 'Humuslaag' }]);
    expect(s.board.coreDone).toBe(true);
    expect(s.newly).toEqual([{ id: 'f1', state: 'full' }]);
    expect(s.turns.map((t) => t.role)).toEqual(['student', 'leap']);
    expect(leaksKey(s)).toBe(false);
  });

  it('feedback die een niet gevonden kenmerk verraadt, wordt vervangen', async () => {
    const llm = async () => ({ results: [], outside: false, feedback: 'Kijk ook naar de schimmeldraden!' });
    const s = await answer(db(), llm, { ...base, text: 'Ik zie bruin.' });
    expect(s.turns[1]).toEqual({ role: 'leap', text: '', code: 'generic', kind: null });
    expect(leaksKey(s)).toBe(false);
  });

  it('hint 1 en 2 komen van het taalmodel, hint 3 laat het kenmerk zien als "met hint"', async () => {
    const llm = async () => ({ hint: 'Kijk eens naar de onderkant.' });
    let s = await hint(db(), llm, base);
    expect(s.turns.at(-1)).toMatchObject({ kind: 'hint', text: 'Kijk eens naar de onderkant.' });
    s = await hint(db(), llm, base);
    s = await hint(db(), llm, base);
    expect(s.turns.at(-1)).toMatchObject({ kind: 'reveal', text: 'Humuslaag: gelige laag onderin' });
    expect(s.board.tiles).toEqual([{ id: 'f1', core: true, state: 'full', how: 'hint', label: 'Humuslaag' }]);
  });

  it('een hint die het label verraadt, wordt vervangen', async () => {
    const s = await hint(db(), async () => ({ hint: 'Zoek de humuslaag!' }), base);
    expect(s.turns.at(-1)).toMatchObject({ code: 'hintGeneric', text: '' });
  });

  it('afronden laat alles zien, met de beschrijving en een terugblik; daarna opnieuw kan', async () => {
    const s = await finish(db(), async () => ({ closing: 'Mooi werk.' }), base);
    expect(s.finished).toBe(true);
    expect(s.description).toBe('GEHEIME BESCHRIJVING');
    expect(s.board.tiles.map((t) => t.label)).toEqual(['Humuslaag', 'Schimmeldraden']);
    // De foto opnieuw openen laat het resultaat zien; opnieuw beginnen geeft een leeg bord.
    const again = await startAttempt(db(), base);
    expect(again.finished).toBe(true);
    const fresh = await restartAttempt(db(), base);
    expect(fresh.finished).toBe(false);
    expect(fresh.board.tiles).toEqual([]);
  });

  it('weigert een leeg antwoord en te veel antwoorden', async () => {
    await expect(answer(db(), async () => ({}), { ...base, text: '  ' })).rejects.toMatchObject({ code: 'emptyAnswer' });
    await startAttempt(db(), base);
    tables.image_exercise_attempts[0].answers = 25;
    await expect(answer(db(), async () => ({ results: [] }), { ...base, text: 'x' })).rejects.toMatchObject({ code: 'tooManyAnswers' });
  });

  it('nakijken mislukt twee keer: foutmelding, niets opgeslagen', async () => {
    await expect(answer(db(), async () => 'kapot', { ...base, text: 'iets' })).rejects.toMatchObject({ code: 'gradeFailed' });
    expect(tables.image_exercise_attempts[0].answers).toBe(0);
  });

  it('elke student heeft een eigen poging', async () => {
    await answer(db(), async () => ({ results: [{ key: 'k1', state: 'full', quote: 'humus' }], feedback: 'Goed.' }), { ...base, text: 'humus' });
    const other = await startAttempt(db(), { ...base, userId: 'stud2' });
    expect(other.board.tiles).toEqual([]);
  });
});
