// Beoordelaars (herzien 2026-09-29): een beoordelaar geeft feedback op werk dat
// de groep inlevert, met een vast aantal rondes, en heeft GEEN verstandhouding.
// Hier de regels die de server daarvoor gebruikt:
//   - alleen staff of groepsleden mogen feedback vragen;
//   - een oordeel moet geldig zijn (anders geen ronde verbruikt);
//   - het aantal rondes is begrensd door max_reviews (null = onbeperkt);
//   - het oordeel wijzigt geen verstandhouding (relationship_delta telt niet mee).

import { describe, it, expect } from 'vitest';
import { validateReviewResponse, canRequestDocumentReview, feedbackRoundsState } from '../documentReview.js';
import { reputationActive, roleFieldsFrom } from '../personaRoles.js';

describe('feedback vragen bij een beoordelaar', () => {
  it('alleen staff of groepsleden', () => {
    expect(canRequestDocumentReview({ isStaff: true, isGroupMember: false }).allowed).toBe(true);
    expect(canRequestDocumentReview({ isStaff: false, isGroupMember: true }).allowed).toBe(true);
    const no = canRequestDocumentReview({ isStaff: false, isGroupMember: false });
    expect(no).toMatchObject({ allowed: false, status: 403 });
  });

  it('een ongeldig oordeel (geen verdict) wordt afgewezen', () => {
    expect(validateReviewResponse('{"grade": 7, "reasoning": "mist verdict"}').ok).toBe(false);
    const ok = validateReviewResponse('{"verdict": "conditional", "grade": 6.4, "reasoning": "Redelijk.", "feed_forward": "Onderbouw je keuze."}');
    expect(ok.ok).toBe(true);
    expect(ok.value).toMatchObject({ verdict: 'conditional', grade: 6.4, feed_forward: 'Onderbouw je keuze.' });
  });

  it('rondes: onbeperkt, of tot het maximum', () => {
    expect(feedbackRoundsState(null, 12)).toEqual({ maxReviews: null, used: 12, remaining: null, canSubmit: true });
    expect(feedbackRoundsState(3, 0)).toMatchObject({ remaining: 3, canSubmit: true });
    expect(feedbackRoundsState(3, 2)).toMatchObject({ remaining: 1, canSubmit: true });
    expect(feedbackRoundsState(3, 3)).toMatchObject({ remaining: 0, canSubmit: false });
    expect(feedbackRoundsState(3, 5)).toMatchObject({ remaining: 0, canSubmit: false });
    expect(feedbackRoundsState(0, 1).canSubmit).toBe(true); // 0/leeg = onbeperkt
  });

  it('een beoordelaar houdt nooit een verstandhouding bij, ook niet als het veld aan staat', () => {
    const fields = roleFieldsFrom({ persona_type: 'evaluator', reputation_enabled: true, max_reviews: 2, deliverable_label: 'Eindproduct' });
    expect(fields).toMatchObject({ reputation_enabled: false, max_reviews: 2, deliverable_label: 'Eindproduct' });
    expect(reputationActive({ persona_type: 'evaluator', reputation_enabled: true })).toBe(false);
  });
});
