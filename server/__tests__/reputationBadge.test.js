// Badge voor de beste verstandhouding (2026-11-10): alleen bij de overgang naar
// het hoogste niveau na een gesprek, voor elk groepslid, één keer per rolspeler.
// Feedback van een beoordelaar geeft nooit een badge (documentReview.integration.test.js).

import { describe, it, expect, beforeEach } from 'vitest';
import { applyConversationJudgement } from '../projects/threadClose.js';
import { earnsReputationBadge, REPUTATION_KIND } from '../projects/reputationBadge.js';
import { makeFakeRelationshipSupabase } from './helpers/fakeRelationshipSupabase.js';

const P = 'proj-1';
const G = 'group-1';
const roleplayer = { id: 'pers-1', name: 'Wethouder', persona_type: 'roleplayer', reputation_enabled: true, start_level: 0, conduct_rules: { levels: {} } };
const msgs = [{ role: 'user', content: 'Goedemiddag.' }, { role: 'assistant', content: 'Welkom.' }];
const chatSaying = (answer) => async () => JSON.stringify(answer);

let state;
let supabaseAdmin;
const close = (threadId, step) => applyConversationJudgement(
  { supabaseAdmin, chat: chatSaying({ step, reason: 'r' }) },
  { persona: roleplayer, projectId: P, groupId: G, threadId, allMsgs: msgs, lang: 'nl' },
);

beforeEach(() => {
  state = {
    relationships: [],
    project: { id: P, course_id: 'course-1', title: 'Amsterdam-Noord' },
    members: [{ group_id: G, user_id: 'u1' }, { group_id: G, user_id: 'u2' }, { group_id: 'other', user_id: 'u3' }],
    achievements: [],
  };
  supabaseAdmin = makeFakeRelationshipSupabase(state);
});

describe('badge voor de beste verstandhouding', () => {
  it('alleen de overgang naar het hoogste niveau telt', () => {
    expect(earnsReputationBadge(1, 2)).toBe(true);
    expect(earnsReputationBadge(2, 2)).toBe(false);
    expect(earnsReputationBadge(0, 1)).toBe(false);
    expect(earnsReputationBadge(-3, 2)).toBe(true);
  });

  it('elk lid van de groep krijgt hem, één keer, met rolspeler en project', async () => {
    state.relationships.push({ id: 'r', project_id: P, group_id: G, persona_id: roleplayer.id, score: 1, history: [] });
    const out = await close('t1', 1);
    expect(out).toMatchObject({ from: 1, to: 2, badge: true });
    expect(state.achievements.map(a => a.user_id).sort()).toEqual(['u1', 'u2']);
    expect(state.achievements[0]).toMatchObject({
      kind: REPUTATION_KIND, course_id: 'course-1', topic_key: roleplayer.id, topic_label: 'Wethouder',
      details: { project_title: 'Amsterdam-Noord', group_id: G },
    });

    // Terug omlaag en weer omhoog: geen tweede badge.
    await close('t2', -1);
    const again = await close('t3', 1);
    expect(again).toMatchObject({ to: 2, badge: false });
    expect(state.achievements).toHaveLength(2);
  });

  it('geen badge onder het hoogste niveau', async () => {
    const out = await close('t1', 1);
    expect(out).toMatchObject({ to: 1, badge: false });
    expect(state.achievements).toHaveLength(0);
  });
});
