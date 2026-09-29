// Integratietest: afgerond gesprek → oordeel op basis van de gedragsregels →
// nieuw niveau van de verstandhouding. Echte threadClose-logica, in-memory
// Supabase en een neptaalmodel (chat) dat we per geval laten antwoorden.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyConversationJudgement, judgeConversation, setRelationshipLevelImpl, transcriptOf } from '../threadClose.js';
import { makeFakeRelationshipSupabase } from './helpers/fakeRelationshipSupabase.js';

const P = 'proj-1';
const G = 'group-1';
const roleplayer = {
  id: 'pers-1', name: 'Wethouder De Vries', persona_type: 'roleplayer', reputation_enabled: true, start_level: 0,
  conduct_rules: { positive: 'Goed voorbereid, respecteert mijn tijd.', negative: 'Onbeleefd, vragen die al in de briefing staan.', levels: {} },
};
const msgs = [
  { role: 'user', content: 'Goedemiddag, we hebben de nota gelezen en drie vragen voorbereid.' },
  { role: 'assistant', content: 'Fijn, gaat uw gang.' },
];

let state;
let supabaseAdmin;
let calls;
const chatSaying = (answer) => async (messages) => { calls.push(messages); return typeof answer === 'string' ? answer : JSON.stringify(answer); };

beforeEach(() => {
  state = { relationships: [] };
  supabaseAdmin = makeFakeRelationshipSupabase(state);
  calls = [];
});

describe('verstandhouding na een afgerond gesprek', () => {
  it('positief oordeel: één stap omhoog, reden in de geschiedenis', async () => {
    const out = await applyConversationJudgement(
      { supabaseAdmin, chat: chatSaying({ step: 1, reason: 'De wethouder waardeert de voorbereiding.' }) },
      { persona: roleplayer, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl' },
    );
    expect(out).toMatchObject({ step: 1, from: 0, to: 1 });
    expect(state.relationships[0].score).toBe(1);
    expect(state.relationships[0].history.at(-1)).toMatchObject({ source: 'persona_chat_close', refId: 'thread_close:t1', step: 1, note: 'De wethouder waardeert de voorbereiding.' });
  });

  it('de gedragsregels gaan naar de beoordeling, niet het gesprek zelf in', async () => {
    await applyConversationJudgement(
      { supabaseAdmin, chat: chatSaying({ step: 0, reason: '' }) },
      { persona: roleplayer, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0].content).toContain('Goed voorbereid, respecteert mijn tijd.');
    expect(calls[0][1].content).toContain('Student: Goedemiddag');
  });

  it('negatief oordeel op "koud" verbreekt het contact; daarna verandert niets meer', async () => {
    state.relationships.push({ id: 'r', project_id: P, group_id: G, persona_id: roleplayer.id, score: -2, history: [] });
    const out = await applyConversationJudgement(
      { supabaseAdmin, chat: chatSaying({ step: -1, reason: 'De groep was opnieuw onbeleefd.' }) },
      { persona: roleplayer, projectId: P, groupId: G, threadId: 't2', allMsgs: msgs, lang: 'nl' },
    );
    expect(out.to).toBe(-3);
    const again = await applyConversationJudgement(
      { supabaseAdmin, chat: chatSaying({ step: 1, reason: 'Excuses.' }) },
      { persona: roleplayer, projectId: P, groupId: G, threadId: 't3', allMsgs: msgs, lang: 'nl' },
    );
    expect(again.to).toBe(-3);
    expect(state.relationships[0].score).toBe(-3);
  });

  it('startniveau van de persona geldt voor een groep zonder rij', async () => {
    const out = await applyConversationJudgement(
      { supabaseAdmin, chat: chatSaying({ step: -1, reason: 'Slecht voorbereid.' }) },
      { persona: { ...roleplayer, start_level: 2 }, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl' },
    );
    expect(out).toMatchObject({ from: 2, to: 1 });
  });

  it('hetzelfde gesprek telt maar één keer (idempotent)', async () => {
    const deps = { supabaseAdmin, chat: chatSaying({ step: 1, reason: 'Goed.' }) };
    const args = { persona: roleplayer, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl' };
    await applyConversationJudgement(deps, args);
    await applyConversationJudgement(deps, args);
    expect(state.relationships[0].score).toBe(1);
    expect(state.relationships[0].history).toHaveLength(1);
  });

  it('geen verstandhouding bij een begeleider, of als de docent hem uit heeft staan', async () => {
    for (const persona of [{ ...roleplayer, persona_type: 'conversational' }, { ...roleplayer, reputation_enabled: false }]) {
      const out = await applyConversationJudgement(
        { supabaseAdmin, chat: chatSaying({ step: 1, reason: 'x' }) },
        { persona, projectId: P, groupId: G, threadId: 't1', allMsgs: msgs, lang: 'nl' },
      );
      expect(out).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(state.relationships).toHaveLength(0);
  });

  it('onbruikbaar of reden-loos antwoord van het model → niveau blijft gelijk', async () => {
    for (const answer of ['geen json', { step: 1 }, { step: 5, reason: '' }]) {
      const r = await judgeConversation({ chat: chatSaying(answer), persona: roleplayer, level: 0, allMsgs: msgs, lang: 'nl' });
      expect(r.step).toBe(0);
    }
    const clamp = await judgeConversation({ chat: chatSaying({ step: 7, reason: 'Heel goed' }), persona: roleplayer, level: 0, allMsgs: msgs, lang: 'nl' });
    expect(clamp.step).toBe(1);
  });

  it('een gesprek zonder inbreng van de studenten wordt niet beoordeeld', async () => {
    const r = await judgeConversation({ chat: chatSaying({ step: -1, reason: 'x' }), persona: roleplayer, level: 0, allMsgs: [{ role: 'assistant', content: 'Hallo?' }], lang: 'nl' });
    expect(r.step).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('setRelationshipLevelImpl begrenst het niveau op -3..+2', async () => {
    const row = await setRelationshipLevelImpl({ supabaseAdmin }, { projectId: P, groupId: G, personaId: 'p', compute: () => 9, event: { source: 'x', refId: 'a' } });
    expect(row.score).toBe(2);
  });

  it('transcriptOf gebruikt de naam van de persona', () => {
    expect(transcriptOf(msgs, 'De Vries')).toBe('Student: Goedemiddag, we hebben de nota gelezen en drie vragen voorbereid.\nDe Vries: Fijn, gaat uw gang.');
  });
});
