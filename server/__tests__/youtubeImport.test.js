// YouTube-video als cursusbron: link herkennen, geplakt transcript lezen,
// opknippen per tijdvak, verwijzingen naar het beeld markeren en opslaan als
// gewone webbron (zodat de rest van LEAP er niets van merkt).
import { describe, it, expect } from 'vitest';
import {
  parseYouTubeId,
  canonicalYouTubeUrl,
  youTubeTimeUrl,
  formatVideoTime,
  parseTranscript,
  chunkTranscript,
  refersToVisual,
  chunkContent,
  chunkMetadata,
  fetchYouTubeTitle,
  saveYouTubeDocument,
} from '../ingestion/youtubeImport.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeId', () => {
  it('herkent de gangbare vormen van een YouTube-link', () => {
    for (const u of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s`,
      `https://m.youtube.com/watch?feature=share&v=${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
    ]) expect(parseYouTubeId(u), u).toBe(ID);
  });

  it('weigert andere sites, nep-domeinen en rare id’s', () => {
    for (const u of [
      '', 'geen url', `https://vimeo.com/${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://evil.example/?u=https://youtube.com/watch?v=${ID}`, 'https://www.youtube.com/watch?v=kort',
      `javascript:alert(1)//youtube.com/watch?v=${ID}`, `ftp://youtube.com/watch?v=${ID}`,
    ]) expect(parseYouTubeId(u), u).toBeNull();
  });

  it('maakt een vaste link en een link naar een moment', () => {
    expect(canonicalYouTubeUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(youTubeTimeUrl(ID, 130.7)).toBe(`https://www.youtube.com/watch?v=${ID}&t=130s`);
    expect(youTubeTimeUrl(ID, 0)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(formatVideoTime(75)).toBe('1:15');
    expect(formatVideoTime(3725)).toBe('1:02:05');
  });
});

describe('parseTranscript', () => {
  it('leest het transcriptvenster van YouTube (tijd op eigen regel, met voorleesregel)', () => {
    const raw = '0:00\n0 seconden\nWelkom bij deze les.\n0:05\n5 seconden\nDe neurale plaat\nvouwt zich.\n1:02\n1 minuut, 2 seconden\nDaarna sluit de buis.';
    expect(parseTranscript(raw)).toEqual([
      { start: 0, text: 'Welkom bij deze les.' },
      { start: 5, text: 'De neurale plaat vouwt zich.' },
      { start: 62, text: 'Daarna sluit de buis.' },
    ]);
  });

  it('leest tijd en tekst op één regel, en uren', () => {
    expect(parseTranscript('0:03 hello there\n1:00:10 later on')).toEqual([
      { start: 3, text: 'hello there' },
      { start: 3610, text: 'later on' },
    ]);
  });

  it('leest SRT en WebVTT', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nEerste zin.\n\n2\n00:00:04,500 --> 00:00:07,000\nTweede zin.';
    expect(parseTranscript(srt)).toEqual([{ start: 1, text: 'Eerste zin.' }, { start: 4, text: 'Tweede zin.' }]);
    const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:05.000\n<c>First</c> line\n\n00:01:00.000 --> 00:01:03.000\nSecond line';
    expect(parseTranscript(vtt)).toEqual([{ start: 2, text: 'First line' }, { start: 60, text: 'Second line' }]);
  });

  it('tekst zonder tijden telt vanaf 0, leeg geeft niets', () => {
    expect(parseTranscript('Alleen tekst\nzonder tijden')).toEqual([{ start: 0, text: 'Alleen tekst zonder tijden' }]);
    expect(parseTranscript('')).toEqual([]);
  });
});

describe('chunkTranscript', () => {
  const seg = (start, text) => ({ start, text });

  it('knipt op een zinseinde zodra het doel bereikt is, met begin- en eindtijd', () => {
    const segments = [seg(0, 'a'.repeat(50) + '.'), seg(10, 'b'.repeat(50) + '.'), seg(20, 'c'.repeat(50) + '.'), seg(30, 'd'.repeat(50) + '.')];
    const chunks = chunkTranscript(segments, { targetChars: 100, maxChars: 500 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ start: 0, end: 20 });
    expect(chunks[1]).toMatchObject({ start: 20, end: 30 });
  });

  it('knipt ook als een tijdvak te lang duurt, en plakt een klein staartje aan het vorige', () => {
    const segments = [seg(0, 'een'), seg(100, 'twee'), seg(200, 'drie'), seg(201, 'x')];
    const chunks = chunkTranscript(segments, { targetChars: 1000, maxSeconds: 150 });
    expect(chunks.map((c) => c.start)).toEqual([0]);
    expect(chunks[0].text).toBe('een twee drie x');
  });
});

describe('verwijzingen naar het beeld', () => {
  it('herkent zinnen als "hier zie je" en "as you can see"', () => {
    expect(refersToVisual('En hier zie je de neurale buis.')).toBe(true);
    expect(refersToVisual('As you can see, the fold closes.')).toBe(true);
    expect(refersToVisual('In this animation the cells migrate.')).toBe(true);
    expect(refersToVisual('De neurale buis sluit in week vier.')).toBe(false);
  });

  it('zet het tijdvak voor de tekst en een notitie bij een beeldverwijzing', () => {
    const plain = chunkContent({ start: 65, end: 130, text: 'De buis sluit.' });
    expect(plain).toBe('[Video 1:05–2:10]\nDe buis sluit.');
    const visual = chunkContent({ start: 65, end: 130, text: 'Hier zie je de plooi.' });
    expect(visual).toContain('Do not describe or guess what is shown');
    expect(visual).toContain('at 1:05');
  });

  it('legt bron, video en tijd vast in de metadata', () => {
    expect(chunkMetadata(ID, { start: 65.4, end: 130.9, text: 'De buis sluit.' })).toEqual({
      source: 'youtube', sourceUrl: canonicalYouTubeUrl(ID), videoId: ID, timeStart: 65, timeEnd: 130,
    });
    expect(chunkMetadata(ID, { start: 0, end: 5, text: 'kijk hier' }).visualRef).toBe(true);
  });
});

describe('fetchYouTubeTitle', () => {
  it('haalt alleen bij YouTube oEmbed op en geeft titel en maker', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ title: ' Neurulatie ', author_name: 'Docent' }) }; };
    expect(await fetchYouTubeTitle(ID, fetchImpl)).toEqual({ title: 'Neurulatie', author: 'Docent' });
    expect(calls[0].startsWith('https://www.youtube.com/oembed?')).toBe(true);
  });

  it('geeft null bij een fout of een ongeldig id, zonder op te halen', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: false }; };
    expect(await fetchYouTubeTitle('../../x', fetchImpl)).toBeNull();
    expect(called).toBe(false);
    expect(await fetchYouTubeTitle(ID, fetchImpl)).toBeNull();
    expect(await fetchYouTubeTitle(ID, async () => { throw new Error('net'); })).toBeNull();
  });
});

describe('saveYouTubeDocument', () => {
  function fakeDb(existing = null) {
    const log = [];
    return {
      log,
      from(table) {
        const ctx = { table, op: 'select', payload: null, eq: {} };
        const run = () => {
          log.push({ ...ctx });
          if (ctx.op === 'insert' && table === 'documents') return { data: { id: 'docNew' }, error: null };
          if (ctx.op === 'select' && table === 'documents') return { data: existing, error: null };
          return { error: null };
        };
        const chain = {
          select() { return chain; },
          eq(c, v) { ctx.eq[c] = v; return chain; },
          insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
          update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
          delete() { ctx.op = 'delete'; return chain; },
          async maybeSingle() { return run(); },
          async single() { return run(); },
          then(res, rej) { return Promise.resolve(run()).then(res, rej); },
        };
        return chain;
      },
    };
  }
  const chunks = [{ start: 0, end: 60, text: 'De buis sluit.' }, { start: 60, end: 90, text: 'Hier zie je de plooi.' }];
  const embed = async (texts) => texts.map(() => [0.1, 0.2]);

  it('slaat een nieuwe video op als webbron met fragmenten en tijden', async () => {
    const db = fakeDb();
    const r = await saveYouTubeDocument(db, { folderId: 'f1', videoId: ID, title: 'Neurulatie', purpose: 'course_material', userId: 'u1', chunks, embed });
    expect(r).toEqual({ documentId: 'docNew', chunks: 2, visualRefs: 1, updated: false });
    const doc = db.log.find((l) => l.table === 'documents' && l.op === 'insert').payload;
    expect(doc).toMatchObject({ file_type: 'web', file_path: canonicalYouTubeUrl(ID), folder_id: 'f1', purpose: 'course_material', processing_status: 'processing' });
    const rows = db.log.find((l) => l.table === 'document_chunks' && l.op === 'insert').payload;
    expect(rows.map((x) => x.metadata.timeStart)).toEqual([0, 60]);
    expect(rows[0].content.startsWith('[Video 0:00–1:00]')).toBe(true);
    const fin = db.log.filter((l) => l.table === 'documents' && l.op === 'update').pop().payload;
    expect(fin).toMatchObject({ processing_status: 'completed', total_chunks: 2 });
  });

  it('werkt dezelfde video bij in plaats van een tweede te maken', async () => {
    const db = fakeDb({ id: 'docOld' });
    const r = await saveYouTubeDocument(db, { folderId: 'f1', videoId: ID, title: 'Neurulatie', purpose: 'course_material', userId: 'u1', chunks, embed });
    expect(r).toMatchObject({ documentId: 'docOld', updated: true });
    expect(db.log.some((l) => l.table === 'documents' && l.op === 'insert')).toBe(false);
    expect(db.log).toContainEqual(expect.objectContaining({ table: 'document_chunks', op: 'delete', eq: { document_id: 'docOld' } }));
  });

  it('raakt niets aan als de embeddings mislukken', async () => {
    const db = fakeDb({ id: 'docOld' });
    await expect(saveYouTubeDocument(db, { folderId: 'f1', videoId: ID, title: 'x', purpose: 'course_material', userId: 'u1', chunks, embed: async () => { throw new Error('429'); } })).rejects.toThrow('429');
    expect(db.log).toEqual([]);
  });
});
