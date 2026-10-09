// Regressie (2026-10-09): "gesprek afsluiten" duurde lang omdat de neerslag
// twee keer werd gemaakt en het oordeel over de verstandhouding daarna pas
// startte. Na het venster mag de bevestiging het taalmodel niet opnieuw nodig hebben.
import { describe, it, expect, beforeEach } from 'vitest';
import { createClosePrep, generateThreadSummary, messagesFingerprint } from '../threadClosePrep.js';
import { applyConversationJudgement, precomputeJudgement } from '../threadClose.js';
import { makeFakeRelationshipSupabase } from './helpers/fakeRelationshipSupabase.js';

const msgs = [
  { role: 'user', content: 'Wij willen de wachtlijsten per wijk vergelijken.' },
  { role: 'assistant', content: 'Goed plan. Spreek af wie welke bron verzamelt.' },
];
const summary = { topics: ['Wachtlijsten per wijk'], agreements: ['Bronnen verdelen'] };

function jobs(overrides = {}) {
  const counts = { summarize: 0, judge: 0 };
  const j = {
    threadId: 't1', allMsgs: msgs, lang: 'nl',
    summarize: async () => { counts.summarize++; return summary; },
    judge: async () => { counts.judge++; return { level: 0, step: 1, reason: 'Goed voorbereid.' }; },
    ...overrides,
  };
  return { j, counts };
}

describe('neerslag en oordeel hergebruiken tussen venster en bevestiging', () => {
  it('na het venster roept afsluiten het taalmodel niet opnieuw aan', async () => {
    const prep = createClosePrep();
    const { j, counts } = jobs();
    expect(await prep.preview(j)).toEqual(summary);
    const out = await prep.forClose(j);
    expect(out.summary).toEqual(summary);
    expect(out.judgement).toEqual({ level: 0, step: 1, reason: 'Goed voorbereid.' });
    expect(out.reused).toEqual({ summary: true, judgement: true });
    expect(counts).toEqual({ summarize: 1, judge: 1 });
    expect(prep.size()).toBe(0); // na afsluiten uit het geheugen
  });

  it('venster twee keer openen: nog steeds één neerslag', async () => {
    const prep = createClosePrep();
    const { j, counts } = jobs();
    await prep.preview(j);
    await prep.preview(j);
    expect(counts).toEqual({ summarize: 1, judge: 1 });
  });

  it('nieuw bericht na het venster: neerslag en oordeel opnieuw', async () => {
    const prep = createClosePrep();
    const { j, counts } = jobs();
    await prep.preview(j);
    const out = await prep.forClose({ ...j, allMsgs: [...msgs, { role: 'user', content: 'Nog één vraag.' }] });
    expect(out.reused).toEqual({ summary: false, judgement: false });
    expect(counts).toEqual({ summarize: 2, judge: 2 });
  });

  it('andere taal: neerslag opnieuw (de tekst moet in de taal van de groep)', async () => {
    const prep = createClosePrep();
    const { j, counts } = jobs();
    await prep.preview(j);
    await prep.forClose({ ...j, lang: 'en' });
    expect(counts.summarize).toBe(2);
    expect(messagesFingerprint(msgs, 'nl')).not.toBe(messagesFingerprint(msgs, 'en'));
  });

  it('verlopen (na 30 min): opnieuw', async () => {
    let t = 0;
    const prep = createClosePrep({ now: () => t });
    const { j, counts } = jobs();
    await prep.preview(j);
    t = 31 * 60 * 1000;
    await prep.forClose(j);
    expect(counts.summarize).toBe(2);
  });

  it('zonder venster lopen neerslag en oordeel tegelijk, niet na elkaar', async () => {
    const prep = createClosePrep();
    const started = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const { j } = jobs({
      summarize: async () => { started.push('summary'); await gate; return summary; },
      judge: async () => { started.push('judge'); await gate; return { level: 0, step: 0, reason: '' }; },
    });
    const p = prep.forClose(j);
    await new Promise(r => setTimeout(r, 0));
    expect(started.sort()).toEqual(['judge', 'summary']); // beide gestart vóór één klaar is
    release();
    await p;
  });

  it('mislukt vooraf-oordeel: bij afsluiten opnieuw proberen', async () => {
    const prep = createClosePrep();
    let n = 0;
    const { j } = jobs({ judge: async () => (++n === 1 ? null : { level: 0, step: -1, reason: 'Onvoorbereid.' }) });
    await prep.preview(j);
    const out = await prep.forClose(j);
    expect(n).toBe(2);
    expect(out.judgement.step).toBe(-1);
  });

  it('geen rolspeler met verstandhouding: geen oordeel', async () => {
    const prep = createClosePrep();
    const { j } = jobs({ judge: null });
    await prep.preview(j);
    expect((await prep.forClose(j)).judgement).toBeNull();
  });
});

describe('neerslag maken', () => {
  it('kort gesprek: geen taalmodel, terugval op het studentbericht', async () => {
    let called = 0;
    const out = await generateThreadSummary({ chat: async () => { called++; return '{}'; }, allMsgs: [msgs[0]], lang: 'nl' });
    expect(called).toBe(0);
    expect(out).toEqual({ topics: ['Wij willen de wachtlijsten per wijk vergelijken.'], agreements: [] });
  });
  it('fout of time-out van het taalmodel: terugval, geen fout', async () => {
    const out = await generateThreadSummary({ chat: async () => { throw new Error('Taalmodel-fout (504)'); }, allMsgs: msgs, lang: 'nl', log: {} });
    expect(out.topics).toEqual(['Wij willen de wachtlijsten per wijk vergelijken.']);
  });
  it('geldig antwoord wordt overgenomen; de prompt bevat het gesprek', async () => {
    let prompt = '';
    const out = await generateThreadSummary({ chat: async (m) => { prompt = m[0].content; return JSON.stringify(summary); }, allMsgs: msgs, lang: 'nl' });
    expect(out).toEqual(summary);
    expect(prompt).toContain('Student: Wij willen');
  });
});

describe('vooraf berekend oordeel bij het opslaan', () => {
  const P = 'proj-1', G = 'group-1';
  const roleplayer = { id: 'pers-1', name: 'Wethouder', persona_type: 'roleplayer', reputation_enabled: true, start_level: 0, conduct_rules: { positive: 'x', negative: 'y' } };
  let state, supabaseAdmin, calls;
  const chat = async (m) => { calls.push(m); return JSON.stringify({ step: 1, reason: 'Goed voorbereid.' }); };
  beforeEach(() => { state = { relationships: [] }; supabaseAdmin = makeFakeRelationshipSupabase(state); calls = []; });

  it('niveau ongewijzigd: oordeel wordt hergebruikt, geen tweede aanroep', async () => {
    const pre = await precomputeJudgement({ supabaseAdmin, chat }, { persona: roleplayer, projectId: P, groupId: G, allMsgs: msgs, lang: 'nl' });
    expect(pre).toEqual({ level: 0, step: 1, reason: 'Goed voorbereid.' });
    expect(state.relationships).toHaveLength(0); // vooraf: niets opgeslagen
    const out = await applyConversationJudgement({ supabaseAdmin, chat }, { persona: roleplayer, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl', precomputed: pre });
    expect(out).toMatchObject({ step: 1, from: 0, to: 1 });
    expect(calls).toHaveLength(1);
  });

  it('niveau intussen veranderd (bv. door de beheerder): opnieuw oordelen', async () => {
    const pre = { level: 0, step: 1, reason: 'oud' };
    state.relationships.push({ id: 'r', project_id: P, group_id: G, persona_id: roleplayer.id, score: -1, history: [] });
    const out = await applyConversationJudgement({ supabaseAdmin, chat }, { persona: roleplayer, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl', precomputed: pre });
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ from: -1, to: 0, reason: 'Goed voorbereid.' });
  });

  it('mislukte beoordeling vooraf telt niet als "geen verandering"', async () => {
    const pre = await precomputeJudgement({ supabaseAdmin, chat: async () => { throw new Error('504'); } }, { persona: roleplayer, projectId: P, groupId: G, allMsgs: msgs, lang: 'nl' });
    expect(pre).toBeNull();
  });
});
