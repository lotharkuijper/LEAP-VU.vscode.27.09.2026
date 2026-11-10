// Feedbackrondes (2026-11-10): feedback op ingeleverd werk én elke keer "Feedback
// op jullie aanpak" tellen mee, zodat de docent met één maximum bepaalt hoeveel
// feedback een groep krijgt. Gedragstest met een nep-database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = { project_group_products: [], project_group_assessments: [] };
let missingAssessments = false;

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: {
    from(table) {
      const filters = [];
      const chain = {
        select() { return chain; },
        eq(col, val) { filters.push(r => r[col] === val); return chain; },
        not(col, op, val) { if (op === 'is' && val === null) filters.push(r => r[col] != null); return chain; },
        then(resolve) {
          if (table === 'project_group_assessments' && missingAssessments) return resolve({ count: null, error: { code: '42P01' } });
          return resolve({ count: rows[table].filter(r => filters.every(f => f(r))).length, error: null });
        },
      };
      return chain;
    },
  },
}));

const { countFeedbackRounds } = await import('../projects/evaluatorReview.js');
const { feedbackRoundsState } = await import('../projects/documentReview.js');

beforeEach(() => {
  missingAssessments = false;
  // Ingeleverd werk (ook als de feedback nog wordt geschreven: het bestand staat er al).
  rows.project_group_products = [
    { group_id: 'g', persona_id: 'ev' },
    { group_id: 'other', persona_id: 'ev' },
  ];
  rows.project_group_assessments = [
    { group_id: 'g', persona_id: 'ev' },
    { group_id: 'g', persona_id: 'other-ev' },
  ];
});

describe('feedbackrondes tellen', () => {
  it('ingeleverd werk plus "Feedback op jullie aanpak", alleen van deze groep en beoordelaar', async () => {
    expect(await countFeedbackRounds('g', 'ev')).toBe(2);
    expect(await countFeedbackRounds('g', 'other-ev')).toBe(1);
  });

  it('bij het maximum kan de groep geen feedback meer vragen', async () => {
    expect(feedbackRoundsState(2, await countFeedbackRounds('g', 'ev')).canSubmit).toBe(false);
    expect(feedbackRoundsState(3, await countFeedbackRounds('g', 'ev')).canSubmit).toBe(true);
  });

  it('oude database zonder tabel voor "Feedback op jullie aanpak": alleen ingeleverd werk', async () => {
    missingAssessments = true;
    expect(await countFeedbackRounds('g', 'ev')).toBe(1);
  });
});
