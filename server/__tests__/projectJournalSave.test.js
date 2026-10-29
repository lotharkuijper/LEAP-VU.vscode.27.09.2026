import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { functionSource, routeSource } from './helpers/serverSource.js';
import {
  checkpointItems, checkpointItemRefs, assessmentRefs, reviewRefs, isSaved, reviewEntry, noteEntry, NOTE_MAX_CHARS,
} from '../projects/projectJournalSave.js';

// Project → leerdagboek alleen op verzoek van de student (2026-10-27). Groeps-
// teksten staan bij de groep; elk lid bewaart zelf in het EIGEN dagboek.

const root = path.resolve(__dirname, '..', '..');
const route = (start) => {
  return routeSource(start);
};

describe('onderdelen en source_refs', () => {
  const cp = { id: 'cp1', kind: 'checkpoint', journal_items: [
    { key: 'main', title: 'Projectreflectie: X', content: 'a', sections: null },
    { key: 'synthesis', title: 'Overzicht', content: 'b', sections: null },
    { key: 'thread:t9', title: 'Sanne', content: 'c', sections: null },
  ] };
  it('nieuwe ref eerst; oude automatische regels tellen ook als bewaard', () => {
    expect(checkpointItemRefs(cp, cp.journal_items[0])).toEqual(['group_checkpoint:cp1:main', 'group_checkpoint:cp1']);
    expect(checkpointItemRefs(cp, cp.journal_items[1])).toEqual(['group_checkpoint:cp1:synthesis', 'group_checkpoint_synthesis:cp1']);
    expect(checkpointItemRefs(cp, cp.journal_items[2])).toEqual(['group_checkpoint:cp1:thread:t9', 'group_thread_checkpoint:cp1:t9']);
    expect(assessmentRefs({ id: 'a1', group_id: 'g', persona_id: 'p', request_id: 'r' })).toEqual(['group_assessment:a1', 'group_evaluate:g:p:r']);
    expect(reviewRefs({ id: 'r1', product_id: 'pr', persona_id: 'p' })).toEqual(['document_review:r1', 'document_review:pr:p:r1']);
    expect(isSaved(['x', 'group_checkpoint:cp1'], new Set(['group_checkpoint:cp1']))).toBe(true);
  });
  it('oude tussenstand zonder journal_items: samenvatting of reflectie', () => {
    expect(checkpointItems({ id: 'c', kind: 'final', ai_summary: 'Goed werk' }, { projectTitle: 'P' }))
      .toEqual([{ key: 'main', title: 'Eindreflectie: P', content: 'Goed werk', sections: null }]);
    expect(checkpointItems({ id: 'c', kind: 'checkpoint' })).toEqual([]);
  });
  it('een badge staat alleen in het dagboek van wie hem kreeg', () => {
    const r = { journal_entry: { title: 'Oordeel', content: 'Feedback: ok', sections: { feedback: 'ok' }, badge: { emoji: '🥇', label: 'Goud' } } };
    expect(reviewEntry(r, { hasBadge: true }).title).toBe('🥇 Oordeel');
    expect(reviewEntry(r, { hasBadge: true }).content).toContain('Badge: 🥇 Goud');
    expect(reviewEntry(r).title).toBe('Oordeel');
  });
  it('eigen reflectie: alleen als er iets staat, met plafond', () => {
    expect(noteEntry('   ')).toBeNull();
    expect(noteEntry('Ik leerde veel', { projectTitle: 'P' }).title).toBe('Mijn eigen reflectie: P');
    expect(noteEntry('x'.repeat(9000)).content.length).toBe(NOTE_MAX_CHARS);
  });
});

describe('koppeling in de server', () => {
  it('tussenstand, feedbackronde en "Beoordeling opvragen" schrijven niet meer in de dagboeken', () => {
    expect(route("app.post('/api/projects/groups/:groupId/checkpoint'")).not.toMatch(/learning_journal_entries'\)\.insert/);
    expect(route("app.post('/api/projects/groups/:groupId/evaluate'")).not.toMatch(/learning_journal_entries'\)\.insert/);
    const review = functionSource('runEvaluatorReview');
    expect(review).not.toMatch(/learning_journal_entries/);
    expect(review).toMatch(/update\(\{ journal_entry: journalEntry \}\)/);
  });
  it('bewaren: alleen groepsleden, leerdagboek-schakelaar, en alleen in het eigen dagboek', () => {
    const save = route("app.post('/api/projects/groups/:groupId/journal-save'");
    expect(save).toMatch(/isGroupMember\(groupId, auth\.user\.id\)/);
    expect(save).toMatch(/courseFeatureOnFor\(auth\.user, null, courseId, 'journal'\)/);
    expect(save).toMatch(/user_id: auth\.user\.id,/);
    expect(save).not.toMatch(/members\.map/);
  });
  it('een afgerond project blijft bereikbaar voor de student', () => {
    expect(route("app.get('/api/projects/student-overview'")).toMatch(/const finishedGroup = groups\.filter\(g => g\.status === 'finalized'\)/);
  });
  it('migratie met terugdraaiscript', () => {
    expect(fs.existsSync(path.join(root, 'supabase', 'migrations', '20261027140000_project_journal_on_request.sql'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261027140000_project_journal_on_request_down.sql'))).toBe(true);
  });
});
