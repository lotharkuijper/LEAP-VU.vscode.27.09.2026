// Feedbackrondes per soort (2026-11-26): feedback op het product (ingeleverde
// voorlopige versies) en feedback op het proces ("Feedback op ons proces") hebben
// elk een eigen maximum. Gedragstest met een nep-database.
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

const { countFeedbackRounds, maxRoundsFor } = await import('../projects/evaluatorReview.js');
const { feedbackRoundsState } = await import('../projects/documentReview.js');

beforeEach(() => {
  missingAssessments = false;
  // Ingeleverd werk (ook als de feedback nog wordt geschreven: het bestand staat er al).
  rows.project_group_products = [
    { group_id: 'g', persona_id: 'ev' },
    { group_id: 'g', persona_id: 'ev' },
    { group_id: 'other', persona_id: 'ev' },
  ];
  rows.project_group_assessments = [
    { group_id: 'g', persona_id: 'ev' },
    { group_id: 'g', persona_id: 'other-ev' },
  ];
});

describe('feedbackrondes tellen, per soort', () => {
  it('product en proces tellen apart, alleen van deze groep en feedbackgever', async () => {
    expect(await countFeedbackRounds('g', 'ev', 'product')).toBe(2);
    expect(await countFeedbackRounds('g', 'ev', 'process')).toBe(1);
    expect(await countFeedbackRounds('g', 'other-ev', 'process')).toBe(1);
    expect(await countFeedbackRounds('g', 'other-ev', 'product')).toBe(0);
  });

  it('een soort zonder rondes houdt de andere niet tegen', async () => {
    const ev = { max_reviews: 2, max_process_reviews: 3 };
    expect(feedbackRoundsState(maxRoundsFor(ev, 'product'), await countFeedbackRounds('g', 'ev', 'product')).canSubmit).toBe(false);
    expect(feedbackRoundsState(maxRoundsFor(ev, 'process'), await countFeedbackRounds('g', 'ev', 'process')).canSubmit).toBe(true);
  });

  it('zonder soort weigert de teller (nooit stilletjes alles samen)', async () => {
    await expect(countFeedbackRounds('g', 'ev')).rejects.toThrow();
  });

  it('oude database zonder tabel voor procesfeedback: nog niets gebruikt', async () => {
    missingAssessments = true;
    expect(await countFeedbackRounds('g', 'ev', 'process')).toBe(0);
    expect(await countFeedbackRounds('g', 'ev', 'product')).toBe(2);
  });

  it('leeg maximum = onbeperkt', () => {
    expect(maxRoundsFor({}, 'process')).toBeNull();
    expect(maxRoundsFor({ max_reviews: 4 }, 'product')).toBe(4);
  });
});
