import { describe, it, expect } from 'vitest';
import { validateReviewResponse, feedbackRoundsState } from '../projects/documentReview.js';

// Feedback van een beoordelaar is zuiver formatief (besluit 2026-11-10).
describe('validateReviewResponse', () => {
  it('accepteert feedback met volgende stap', () => {
    expect(validateReviewResponse({ feedback: ' Goed begin. ', feed_forward: ' Werk de analyse uit. ' }))
      .toEqual({ ok: true, value: { feedback: 'Goed begin.', feed_forward: 'Werk de analyse uit.' } });
  });
  it('accepteert JSON-string en het databaseveld reasoning', () => {
    expect(validateReviewResponse('{"reasoning": "Helder."}')).toEqual({ ok: true, value: { feedback: 'Helder.', feed_forward: '' } });
  });
  it('laat een cijfer, oordeel of verstandhouding nooit door', () => {
    const r = validateReviewResponse({ feedback: 'x', grade: 9, verdict: 'accepted', relationship_delta: 5, badge: 'goud' });
    expect(Object.keys(r.value).sort()).toEqual(['feed_forward', 'feedback']);
  });
  it('weigert ongeldige JSON, geen object en lege feedback', () => {
    expect(validateReviewResponse('{niet json').ok).toBe(false);
    expect(validateReviewResponse([]).ok).toBe(false);
    expect(validateReviewResponse(null).ok).toBe(false);
    expect(validateReviewResponse({ feedback: '   ' }).ok).toBe(false);
  });
});

describe('feedbackRoundsState', () => {
  it('negatief of niet-numeriek gebruik telt als 0', () => {
    expect(feedbackRoundsState(2, -3)).toMatchObject({ used: 0, remaining: 2 });
    expect(feedbackRoundsState(2, 'x')).toMatchObject({ used: 0, remaining: 2 });
  });
});
