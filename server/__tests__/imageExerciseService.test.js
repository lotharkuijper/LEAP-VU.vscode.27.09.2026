// Beeldoefeningen, docentkant: foto's opslaan, beschrijvingen koppelen, bevestigen,
// kenmerken maken en aanpassen. Alles blijft binnen de eigen cursus.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPhoto, applyDescriptionText, removeCoursePhotos, confirmExercises, deleteExercise, generateFeatures,
  listExercises, saveFeatures, setFeatureCore, sniffImageType, suggestMatches, updateExercise,
} from '../imageExercises/service.js';

let tables;
let storage;

function fakeDb() {
  return {
    from(table) {
      const f = { eq: [], in: [] };
      let op = 'select';
      let payload = null;
      let head = false;
      const rows = () => (tables[table] ||= []);
      const match = (r) => f.eq.every(([k, v]) => r[k] === v) && f.in.every(([k, v]) => v.includes(r[k]));
      const run = () => {
        if (op === 'insert') {
          const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: p.id || `id${rows().length + 1}`, ...p }));
          rows().push(...list);
          return { data: list[0], error: null };
        }
        if (op === 'update') { rows().filter(match).forEach((r) => Object.assign(r, payload)); return { error: null }; }
        if (op === 'delete') { tables[table] = rows().filter((r) => !match(r)); return { error: null }; }
        const hit = rows().filter(match);
        return head ? { count: hit.length, error: null } : { data: hit.map((r) => ({ ...r })), error: null };
      };
      const chain = {
        select(_c, o) { head = !!o?.head; return chain; },
        eq(k, v) { f.eq.push([k, v]); return chain; },
        in(k, v) { f.in.push([k, v]); return chain; },
        order() { return chain; },
        insert(p) { op = 'insert'; payload = p; return chain; },
        update(p) { op = 'update'; payload = p; return chain; },
        delete() { op = 'delete'; return chain; },
        async maybeSingle() { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null }; },
        async single() { return run(); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return chain;
    },
    storage: {
      from() {
        return {
          async upload(path, buf) { storage.set(path, buf); return { error: null }; },
          async remove(paths) { paths.forEach((p) => storage.delete(p)); return { error: null }; },
          async createSignedUrls(paths) { return { data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })) }; },
          async list(prefix) { return { data: [...storage.keys()].filter((k) => k.startsWith(prefix + '/')).map((k) => ({ name: k.slice(prefix.length + 1) })) }; },
          async download(path) { const b = storage.get(path); return b ? { data: { arrayBuffer: async () => b } } : { error: { message: 'weg' } }; },
        };
      },
    },
  };
}

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
let n = 0;
const newId = () => `ex${++n}`;
const db = () => fakeDb();

beforeEach(() => {
  tables = { image_exercises: [], image_exercise_features: [] };
  storage = new Map();
  n = 0;
});

async function photo(name, courseId = 'c1', buf = JPG) {
  return (await addPhoto(db(), { courseId, userId: 't1', filename: name, buffer: buf, newId })).id;
}

describe('foto’s', () => {
  it('slaat een foto op in de eigen map van de cursus', async () => {
    const id = await photo('alzheimer-01.jpg');
    expect(tables.image_exercises[0]).toMatchObject({ id, course_id: 'c1', mime_type: 'image/jpeg', storage_path: `c1/${id}.jpg`, position: 0 });
    expect(storage.has(`c1/${id}.jpg`)).toBe(true);
  });

  it('weigert iets wat geen foto is, ook als de naam op .jpg eindigt', async () => {
    await expect(photo('virus.jpg', 'c1', Buffer.from('<script>alert(1)</script>....'))).rejects.toMatchObject({ code: 'badImageType' });
    await expect(photo('tekst.pdf')).rejects.toMatchObject({ code: 'badImageType' });
    expect(tables.image_exercises).toEqual([]);
    expect(sniffImageType(PNG)).toBe('image/png');
  });
});

describe('beschrijvingen koppelen en bevestigen', () => {
  it('koppelt op nummer en naam, slaat over wat al bevestigd is, en geeft losse stukken terug', async () => {
    const a = await photo('alzheimer-01.jpg');
    const b = await photo('alzheimer-02.jpg');
    const s = await photo('schist.png', 'c1', PNG);
    tables.image_exercises.find((r) => r.id === s).description_confirmed_at = '2026-11-01';
    const r = await applyDescriptionText(db(), { courseId: 'c1', text: 'Foto 1\nHersenweefsel.\n\nFoto 2\nGezond weefsel.\n\nschist.png\nNieuwe tekst.\n\nFoto 9\nLos stuk.' });
    expect(r.matched).toEqual([{ id: a, source: 'number' }, { id: b, source: 'number' }]);
    expect(r.unmatchedSections.map((x) => x.heading)).toEqual(['schist.png', 'Foto 9']);
    expect(r.alreadyConfirmed).toBe(1);
    expect(tables.image_exercises.find((x) => x.id === a)).toMatchObject({ description: 'Hersenweefsel.', match_source: 'number', description_confirmed_at: null });
  });

  it('één foto en een document zonder kopjes: de hele tekst is een voorstel voor die foto', async () => {
    const a = await photo('Art-nouveau.png', 'c1', PNG);
    const text = 'Dit is een typische art-nouveaucompositie.\nHet haar\n•\tGolvend haar.';
    const r = await applyDescriptionText(db(), { courseId: 'c1', text, filename: 'beschrijving.docx' });
    expect(r).toMatchObject({ method: 'single', matched: [{ id: a, source: 'suggested' }], unmatchedSections: [] });
    expect(tables.image_exercises[0]).toMatchObject({ description: text, description_confirmed_at: null });
  });

  it('meerdere foto’s en een document zonder kopjes: de docent kiest de foto', async () => {
    await photo('a.jpg');
    await photo('b.jpg');
    const r = await applyDescriptionText(db(), { courseId: 'c1', text: 'Zomaar wat tekst.', filename: 'notities.docx' });
    expect(r).toMatchObject({ method: 'ask', matched: [], unmatchedSections: [{ heading: 'notities.docx', text: 'Zomaar wat tekst.' }] });
  });

  it('een document met dezelfde naam als een foto hoort bij die foto', async () => {
    await photo('a.jpg');
    const b = await photo('kaart-02.jpg');
    const r = await applyDescriptionText(db(), { courseId: 'c1', text: 'Een kaart.', filename: 'kaart-02.docx' });
    expect(r).toMatchObject({ method: 'filename', matched: [{ id: b, source: 'name' }] });
  });

  it('bij de foto zelf geüpload: de hele tekst hoort bij die foto, alleen in de eigen cursus', async () => {
    await photo('a.jpg');
    const b = await photo('b.jpg');
    const r = await applyDescriptionText(db(), { courseId: 'c1', text: 'Foto 1\nDit is b.', exerciseId: b });
    expect(r).toMatchObject({ method: 'photo', matched: [{ id: b, source: 'manual' }] });
    expect(tables.image_exercises.find((x) => x.id === b).description).toBe('Foto 1\nDit is b.');
    await expect(applyDescriptionText(db(), { courseId: 'c2', text: 'x', exerciseId: b })).rejects.toMatchObject({ status: 404 });
    await expect(applyDescriptionText(db(), { courseId: 'c1', text: '   ' })).rejects.toMatchObject({ code: 'emptyDocument' });
  });

  it('bevestigt alleen foto’s van de eigen cursus met een beschrijving', async () => {
    const a = await photo('a.jpg');
    const leeg = await photo('b.jpg');
    const ander = await photo('c.jpg', 'c2');
    for (const r of tables.image_exercises) if (r.id !== leeg) r.description = 'Iets.';
    const { confirmed } = await confirmExercises(db(), { courseId: 'c1', ids: [a, leeg, ander] });
    expect(confirmed).toEqual([a]);
    expect(tables.image_exercises.find((r) => r.id === ander).description_confirmed_at).toBeUndefined();
  });

  it('een nieuwe beschrijving maakt de koppeling onbevestigd en gooit de kenmerken weg', async () => {
    const a = await photo('a.jpg');
    Object.assign(tables.image_exercises[0], { description: 'Oud.', description_confirmed_at: 'x', features_status: 'ready' });
    tables.image_exercise_features.push({ id: 'f1', exercise_id: a, label: 'Oud' });
    await updateExercise(db(), { courseId: 'c1', id: a, description: 'Nieuw.', matchSource: 'typed' });
    expect(tables.image_exercises[0]).toMatchObject({ description: 'Nieuw.', match_source: 'typed', description_confirmed_at: null, features_status: 'none' });
    expect(tables.image_exercise_features).toEqual([]);
  });

  it('instellingen alleen met geldige waarden, en nooit voor een andere cursus', async () => {
    const a = await photo('a.jpg');
    await updateExercise(db(), { courseId: 'c1', id: a, depth: 'interpret', countDisplay: 'exact' });
    expect(tables.image_exercises[0]).toMatchObject({ depth: 'interpret', count_display: 'exact' });
    await expect(updateExercise(db(), { courseId: 'c1', id: a, depth: 'alles' })).rejects.toMatchObject({ status: 400 });
    await expect(updateExercise(db(), { courseId: 'c2', id: a, depth: 'name' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('kenmerken', () => {
  it('maakt kenmerken uit de beschrijving en zet de status', async () => {
    const a = await photo('a.jpg');
    tables.image_exercises[0].description = 'Hersenweefsel met plaques.';
    const llm = async () => ({ features: [{ label: 'Hersenweefsel', core: true }, { label: 'Plaques', core: false }], uncertain: true, note: 'kort' });
    expect(await generateFeatures(db(), llm, a)).toMatchObject({ ok: true, count: 2, uncertain: true });
    expect(tables.image_exercise_features.map((f) => [f.label, f.is_core, f.source])).toEqual([['Hersenweefsel', true, 'auto'], ['Plaques', false, 'auto']]);
    expect(tables.image_exercises[0]).toMatchObject({ features_status: 'ready', features_uncertain: true, features_note: 'kort' });
  });

  it('bij twee mislukte pogingen: status mislukt, geen kenmerken', async () => {
    const a = await photo('a.jpg');
    tables.image_exercises[0].description = 'Iets.';
    let calls = 0;
    await generateFeatures(db(), async () => { calls++; return 'geen json'; }, a);
    expect(calls).toBe(2);
    expect(tables.image_exercises[0].features_status).toBe('failed');
    expect(tables.image_exercise_features).toEqual([]);
  });

  it('gooit het resultaat weg als de beschrijving intussen veranderde', async () => {
    const a = await photo('a.jpg');
    tables.image_exercises[0].description = 'Eerste.';
    const llm = async () => { tables.image_exercises[0].description = 'Tweede.'; return { features: [{ label: 'X' }] }; };
    expect(await generateFeatures(db(), llm, a)).toMatchObject({ stale: true });
    expect(tables.image_exercise_features).toEqual([]);
  });

  it('de docent past de lijst aan en zet een kenmerk op extra', async () => {
    const a = await photo('a.jpg');
    await saveFeatures(db(), { courseId: 'c1', id: a, features: [{ label: 'Plaques' }, { label: 'Gliose', is_core: false }] });
    expect(tables.image_exercise_features.map((f) => [f.label, f.is_core, f.source])).toEqual([['Plaques', true, 'teacher'], ['Gliose', false, 'teacher']]);
    expect(tables.image_exercises[0].features_reviewed_at).toBeTruthy();
    await expect(saveFeatures(db(), { courseId: 'c1', id: a, features: [] })).rejects.toMatchObject({ code: 'noFeatures' });
    const fid = tables.image_exercise_features[0].id;
    await setFeatureCore(db(), { courseId: 'c1', featureId: fid, isCore: false });
    expect(tables.image_exercise_features[0].is_core).toBe(false);
    await expect(setFeatureCore(db(), { courseId: 'c2', featureId: fid, isCore: true })).rejects.toMatchObject({ status: 404 });
  });
});

describe('overzicht, voorstel en verwijderen', () => {
  it('geeft per foto de beschrijving, kenmerken en een tijdelijke link; alleen van de eigen cursus', async () => {
    const a = await photo('a.jpg');
    await photo('b.jpg', 'c2');
    tables.image_exercise_features.push({ id: 'f1', exercise_id: a, label: 'Plaques', is_core: true, open_interpretation: false, source: 'auto' });
    const list = await listExercises(db(), 'c1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a, imageUrl: `https://signed/c1/${a}.jpg`, confirmed: false, features: [{ id: 'f1', label: 'Plaques' }] });
  });

  it('doet een voorstel alleen voor foto’s zonder beschrijving', async () => {
    const a = await photo('a.jpg');
    const b = await photo('b.jpg');
    tables.image_exercises.find((r) => r.id === b).description = 'Al gekoppeld.';
    const seen = [];
    const vision = async (m) => { seen.push(m[1].content[1].image_url.url.slice(0, 23)); return { index: 1, confidence: 'high' }; };
    const r = await suggestMatches(db(), vision, { courseId: 'c1', sections: ['eerste', 'tweede'] });
    expect(r.suggestions).toEqual([{ id: a, section: 1, confidence: 'high' }]);
    expect(seen).toEqual(['data:image/jpeg;base64,']);
    expect((await suggestMatches(db(), async () => ({ index: 7 }), { courseId: 'c1', sections: ['x'] })).suggestions).toEqual([]);
  });

  it('verwijdert de foto uit de lijst en uit de opslag, niet van een andere cursus', async () => {
    const a = await photo('a.jpg');
    await expect(deleteExercise(db(), { courseId: 'c2', id: a })).rejects.toMatchObject({ status: 404 });
    await deleteExercise(db(), { courseId: 'c1', id: a });
    expect(tables.image_exercises).toEqual([]);
    expect(storage.size).toBe(0);
  });
});

describe('cursus verwijderd', () => {
  it('ruimt alleen de foto’s van die cursus op', async () => {
    await photo('a.jpg');
    await photo('b.jpg');
    await photo('c.jpg', 'c2');
    expect(await removeCoursePhotos(db(), 'c1')).toEqual({ removed: 2 });
    expect([...storage.keys()].every((k) => k.startsWith('c2/'))).toBe(true);
  });
});
